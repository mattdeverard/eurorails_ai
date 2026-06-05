import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import playerRoutes from './routes/playerRoutes';
import trackRoutes from './routes/trackRoutes';
import gameRoutes from './routes/gameRoutes';
import deckRoutes from './routes/deckRoutes';
import loadRoutes from './routes/loadRoutes';
import lobbyRoutes from './routes/lobbyRoutes';
import authRoutes from './routes/authRoutes';
import chatRoutes from './routes/chatRoutes';
import whisperRoutes from './routes/whisperRoutes';
import logRoutes, { llmRouter } from './routes/logRoutes';
import { checkDatabase, db } from './db';
import { PlayerService } from './services/playerService';
import { addRequestId } from './middleware/errorHandler';
import { initializeSocketIO } from './services/socketService';
import { initializeCleanupJobs } from './cron/cleanupJobs';
import { moderationService } from './services/moderationService';

const app = express();
// Railway provides PORT env var, fallback to 3000 for consistency with Docker health check
const port = parseInt(process.env.PORT || '3001', 10);
const serverPort = parseInt(process.env.SERVER_LOCAL_PORT || '3000', 10);

// Store server instance for health check diagnostics
let httpServer: http.Server | null = null;

// Cache the base HTML template to avoid reading on every request
// Removed cachedHtmlTemplate - no longer needed since we serve static files directly

// Configure CORS origins
function getCorsOrigins(): string | string[] {
    // If ALLOWED_ORIGINS is set, use it (comma-separated list)
    if (process.env.ALLOWED_ORIGINS) {
        const origins = process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);
        return origins;
    }
    
    // If CLIENT_URL is set, use it
    if (process.env.CLIENT_URL) {
        return process.env.CLIENT_URL;
    }
    
    // In development, default to localhost on the configured server port
    if (process.env.NODE_ENV === 'development') {
        const defaultOrigin = `http://localhost:${serverPort}`;
        return defaultOrigin;
    }
    
    // In production, require explicit configuration - fail fast for security
    if (process.env.NODE_ENV === 'production') {
        console.error('========================================');
        console.error('SECURITY ERROR: CORS not configured for production!');
        console.error('Production deployments MUST set CLIENT_URL or ALLOWED_ORIGINS');
        console.error('Falling back to localhost is INSECURE and will block legitimate requests.');
        console.error('========================================');
        // Still return localhost as fallback for backwards compatibility,
        // but log a clear error that this must be fixed
        return `http://localhost:${serverPort}`;
    }
    
    // For test environment or other cases, default to localhost
    console.warn('CORS: No CLIENT_URL or ALLOWED_ORIGINS set. Defaulting to localhost');
    return `http://localhost:${serverPort}`;
}

// Middleware for parsing JSON and serving static files
// CORS configuration - use function to evaluate at request time for dynamic origins
app.use(cors({
    origin: (origin, callback) => {
        const allowedOrigins = getCorsOrigins();
        
        // If no origin (e.g., same-origin request, Postman), allow it
        if (!origin) {
            return callback(null, true);
        }
        
        // Check if origin is in allowed list
        if (Array.isArray(allowedOrigins)) {
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
        } else if (allowedOrigins === origin || allowedOrigins === '*') {
            return callback(null, true);
        }
        
        // Origin not allowed
        console.warn(`CORS blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(addRequestId);

// API Routes - make sure this comes before static file serving
app.use('/api/auth', authRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/tracks', trackRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/deck', deckRoutes);
app.use('/api/loads', loadRoutes);
app.use('/api/lobby', lobbyRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/games', whisperRoutes);

// Log viewer routes (dev tool — no auth)
app.use('/logs', logRoutes);
app.use('/log', logRoutes);
app.use('/llm', llmRouter);

// Static file serving
app.use(express.static(path.join(__dirname, '../../dist/client')));
// Also serve public assets
app.use('/assets', express.static(path.join(__dirname, '../../public/assets')));

// Debug endpoint
app.get('/api/test', (req, res) => {
    res.json({ message: 'API is working' });
});

// Helper function to make internal HTTP request
async function testInternalEndpoint(url: string, timeout: number = 2000): Promise<{ success: boolean; statusCode?: number; error?: string; duration?: number }> {
    const startTime = Date.now();
    return new Promise((resolve) => {
        const request = http.get(url, { timeout }, (response) => {
            const duration = Date.now() - startTime;
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                resolve({
                    success: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300,
                    statusCode: response.statusCode,
                    duration
                });
            });
        });
        
        request.on('error', (err: any) => {
            const duration = Date.now() - startTime;
            resolve({
                success: false,
                error: err.message || 'Unknown error',
                duration
            });
        });
        
        request.on('timeout', () => {
            request.destroy();
            const duration = Date.now() - startTime;
            resolve({
                success: false,
                error: 'Request timeout',
                duration
            });
        });
    });
}

// Health check endpoint for Railway and monitoring
app.get('/health', async (req, res) => {
    // Diagnostic information to help debug 502 errors on root path
    const indexPath = path.join(__dirname, '../../dist/client/index.html');
    const clientDistPath = path.join(__dirname, '../../dist/client');
    
    let fileExists = false;
    let fileError: string | null = null;
    let dirExists = false;
    let dirError: string | null = null;
    
    // Check if index.html exists
    try {
        await fs.promises.access(indexPath, fs.constants.F_OK);
        fileExists = true;
    } catch (err: any) {
        fileError = err.message || 'Unknown error';
    }
    
    // Check if dist/client directory exists
    try {
        await fs.promises.access(clientDistPath, fs.constants.F_OK);
        dirExists = true;
    } catch (err: any) {
        dirError = err.message || 'Unknown error';
    }
    
    // Test internal endpoints to see if routes are working
    // Use 127.0.0.1 for internal requests (more reliable than localhost)
    // Use shorter timeout (1s each) to stay within Docker HEALTHCHECK timeout (3s)
    const internalHost = '127.0.0.1';
    const serverUrl = `http://${internalHost}:${port}`;
    const rootPathTest = await testInternalEndpoint(`${serverUrl}/`, 1000);
    const apiTestTest = await testInternalEndpoint(`${serverUrl}/api/test`, 1000);
    
    // Build diagnostics object
    const diagnostics = {
        indexHtml: {
            exists: fileExists,
            path: indexPath,
            resolvedPath: path.resolve(indexPath),
            error: fileError
        },
        clientDist: {
            exists: dirExists,
            path: clientDistPath,
            resolvedPath: path.resolve(clientDistPath),
            error: dirError
        },
        serverInfo: {
            __dirname: __dirname,
            cwd: process.cwd(),
            nodeEnv: process.env.NODE_ENV,
            port: port,
            serverAddress: httpServer?.address() || null,
            envVars: {
                CLIENT_URL: process.env.CLIENT_URL || '(not set)',
                VITE_API_BASE_URL: process.env.VITE_API_BASE_URL || '(not set)',
                VITE_SOCKET_URL: process.env.VITE_SOCKET_URL || '(not set)',
                PORT: process.env.PORT || '(not set)',
                NODE_ENV: process.env.NODE_ENV || '(not set)'
            }
        },
        endpointTests: {
            rootPath: {
                url: `${serverUrl}/`,
                ...rootPathTest
            },
            apiTest: {
                url: `${serverUrl}/api/test`,
                ...apiTestTest
            }
        }
    };
    
    // Always return 200 so Railway doesn't restart, but include diagnostics
    res.status(200).json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        diagnostics: diagnostics
    });
});

// SPA fallback - serve index.html for all non-API, non-asset routes
// Configuration is baked into the bundle at build time via webpack DefinePlugin
app.get('*', (req, res, next) => {
    // Skip if this is an API route
    if (req.path.startsWith('/api/')) {
        return next();
    }

    // Skip if this is an asset route
    if (req.path.startsWith('/assets/')) {
        return next();
    }

    // Skip if this is a static file (has file extension)
    if (req.path.includes('.')) {
        return next();
    }

    // Serve the static index.html file
    // All configuration is baked in at build time via webpack DefinePlugin
    const indexPath = path.join(__dirname, '../../dist/client/index.html');
    res.sendFile(indexPath, (err) => {
        if (err) {
            console.error('Error serving index.html:', err);
            console.error('Request path:', req.path);
            console.error('Resolved index.html path:', path.resolve(indexPath));

            if (res.headersSent) {
                console.error('Headers already sent, closing connection');
                return res.end();
            }

            const statusCode = (err as any).status || 500;
            res.status(statusCode).json({
                error: 'Failed to serve application',
                message: err.message || 'Internal server error',
                path: req.path
            });
        }
    });
});

// Initialize database and start server
async function startServer() {
    try {
        // Check database connection and schema
        const dbReady = await checkDatabase();
        if (!dbReady) {
            console.error('Database initialization failed');
            process.exit(1);
        }

        // Initialize moderation service in background (verifies the Gemini model is reachable)
        // Server starts immediately; moderation becomes available once the model responds
        console.log('[Startup] Initializing moderation service (background)...');
        moderationService.initialize().then(() => {
            console.log('[Startup] Moderation service ready');
        }).catch((error) => {
            console.error('[Startup] Failed to initialize moderation service:', error);
            console.error('[Startup] Chat moderation will not be available');
        });

        // Initialize cleanup jobs (cron)
        try {
            initializeCleanupJobs();
            console.log('[Startup] Cleanup jobs initialized');
        } catch (error) {
            console.error('[Startup] Failed to initialize cleanup jobs:', error);
            // Don't exit - cleanup is not critical for startup
        }

        // Initialize default game
        try {
            const gameId = await PlayerService.initializeDefaultGame();
        } catch (err) {
            console.error('Failed to initialize default game:', err);
            // Don't exit - the game might already exist
        }

        // Create HTTP server
        const server = http.createServer(app);
        httpServer = server; // Store for health check diagnostics

        // Initialize Socket.IO with error handling
        try {
            initializeSocketIO(server);
        } catch (error) {
            console.error('Failed to initialize Socket.IO:', error);
            // Continue server startup even if Socket.IO fails
            // This allows the app to run without real-time features
        }

        // Start server - explicitly bind to 0.0.0.0 to accept connections from Railway
        server.listen(port, '0.0.0.0', () => {
            console.log(`API server listening on port ${port}`);
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Add error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({
        message: err.message || 'Internal server error'
    });
});

startServer(); 