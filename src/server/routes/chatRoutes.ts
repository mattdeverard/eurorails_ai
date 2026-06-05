import express, { Request, Response } from 'express';
import { BlockService } from '../services/blockService';
import { moderationService } from '../services/moderationService';
import { ChatService } from '../services/chatService';
import { asyncHandler } from '../middleware/errorHandler';
import { authenticateToken, requireAuth } from '../middleware/authMiddleware';
import { db } from '../db';

const router = express.Router();

/**
 * GET /api/chat/settings
 * Get user's chat settings
 */
router.get('/settings', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;

  try {
    // Get user's chat_enabled setting
    const userResult = await db.query(
      'SELECT chat_enabled FROM users WHERE id = $1',
      [user.id]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
      return;
    }

    const chatEnabled = userResult.rows[0].chat_enabled;

    // Get blocked users
    const blockedUsers = await BlockService.getBlockedUsers(user.id);

    res.status(200).json({
      success: true,
      data: {
        chatEnabled,
        blockedUsers
      },
      message: 'Chat settings retrieved successfully'
    });
  } catch (error) {
    console.error('Get chat settings error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to get chat settings',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * PUT /api/chat/settings
 * Update user's chat enabled status
 */
router.put('/settings', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { chatEnabled } = req.body;

  if (typeof chatEnabled !== 'boolean') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'chatEnabled must be a boolean',
      details: 'Please provide true or false'
    });
    return;
  }

  try {
    await db.query(
      'UPDATE users SET chat_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [chatEnabled, user.id]
    );

    res.status(200).json({
      success: true,
      data: {
        chatEnabled
      },
      message: `Chat ${chatEnabled ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    console.error('Update chat settings error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update chat settings',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * POST /api/chat/block
 * Block a user (prevents chat communication)
 */
router.post('/block', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { blockedUserId } = req.body;

  if (!blockedUserId || typeof blockedUserId !== 'string') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'blockedUserId is required',
      details: 'Please provide a valid user ID'
    });
    return;
  }

  // Check if trying to block self
  if (user.id === blockedUserId) {
    res.status(400).json({
      error: 'CANNOT_BLOCK_SELF',
      message: 'You cannot block yourself',
      details: 'Please select a different user'
    });
    return;
  }

  try {
    // Verify blocked user exists
    const blockedUserResult = await db.query(
      'SELECT id, username FROM users WHERE id = $1',
      [blockedUserId]
    );

    if (blockedUserResult.rows.length === 0) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User to block not found',
        details: 'Please provide a valid user ID'
      });
      return;
    }

    await BlockService.blockUser(user.id, blockedUserId);

    res.status(200).json({
      success: true,
      message: 'User blocked successfully',
      details: `${blockedUserResult.rows[0].username} has been blocked`
    });
  } catch (error) {
    console.error('Block user error:', error);
    
    if (error instanceof Error && error.message === 'CANNOT_BLOCK_SELF') {
      res.status(400).json({
        error: 'CANNOT_BLOCK_SELF',
        message: 'You cannot block yourself'
      });
      return;
    }
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to block user',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * POST /api/chat/unblock
 * Unblock a user
 */
router.post('/unblock', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { blockedUserId } = req.body;

  if (!blockedUserId || typeof blockedUserId !== 'string') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'blockedUserId is required',
      details: 'Please provide a valid user ID'
    });
    return;
  }

  try {
    // Verify blocked user exists
    const blockedUserResult = await db.query(
      'SELECT id, username FROM users WHERE id = $1',
      [blockedUserId]
    );

    if (blockedUserResult.rows.length === 0) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'User to unblock not found',
        details: 'Please provide a valid user ID'
      });
      return;
    }

    await BlockService.unblockUser(user.id, blockedUserId);

    res.status(200).json({
      success: true,
      message: 'User unblocked successfully',
      details: `${blockedUserResult.rows[0].username} has been unblocked`
    });
  } catch (error) {
    console.error('Unblock user error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to unblock user',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * GET /api/chat/messages/:gameId
 * Get paginated messages for a conversation
 * Query params:
 * - recipientType: 'game' | 'player'
 * - recipientId: string (userId for DMs, gameId for game chat)
 * - page: number (default 1)
 * - limit: number (default 30, max 30)
 */
router.get('/messages/:gameId', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { gameId } = req.params;
  const { recipientType, recipientId, page, limit } = req.query;

  // Validate required params
  if (!recipientType || !recipientId) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'recipientType and recipientId are required',
      details: 'Please provide both query parameters'
    });
    return;
  }

  if (recipientType !== 'game' && recipientType !== 'player') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'recipientType must be either "game" or "player"',
      details: 'Invalid recipient type'
    });
    return;
  }

  try {
    // Verify user is in the game
    const playerResult = await db.query(
      'SELECT id FROM players WHERE game_id = $1 AND user_id = $2 AND is_deleted = false',
      [gameId, user.id]
    );

    if (playerResult.rows.length === 0) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You are not in this game'
      });
      return;
    }

    const pageNum = parseInt(page as string, 10) || 1;
    const limitNum = Math.min(parseInt(limit as string, 10) || 30, 30);

    const messagePage = await ChatService.getMessages(
      gameId,
      recipientType as 'game' | 'player',
      recipientId as string,
      user.id,
      pageNum,
      limitNum
    );

    res.status(200).json({
      success: true,
      data: messagePage,
      message: 'Messages retrieved successfully'
    });
  } catch (error) {
    console.error('Get messages error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to get messages',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * GET /api/chat/unread/:gameId
 * Get unread message counts for user in a game
 */
router.get('/unread/:gameId', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { gameId } = req.params;

  try {
    // Verify user is in the game
    const playerResult = await db.query(
      'SELECT id FROM players WHERE game_id = $1 AND user_id = $2 AND is_deleted = false',
      [gameId, user.id]
    );

    if (playerResult.rows.length === 0) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You are not in this game'
      });
      return;
    }

    const unreadCounts = await ChatService.getUnreadCounts(gameId, user.id);

    res.status(200).json({
      success: true,
      data: unreadCounts,
      message: 'Unread counts retrieved successfully'
    });
  } catch (error) {
    console.error('Get unread counts error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to get unread counts',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * POST /api/chat/mark-read
 * Mark messages as read
 */
router.post('/mark-read', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { messageIds } = req.body;

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'messageIds must be a non-empty array',
      details: 'Please provide message IDs to mark as read'
    });
    return;
  }

  // Validate all IDs are numbers or numeric strings (strict validation with regex)
  if (!messageIds.every((id) => typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'All messageIds must be numbers or numeric strings',
      details: 'Invalid message ID format'
    });
    return;
  }

  // Deduplicate message IDs to avoid duplicate counting
  const uniqueMessageIds = [...new Set(messageIds)];

  // Convert all to numbers if they're numeric strings
  const numericIds = uniqueMessageIds.map(id => typeof id === 'string' ? parseInt(id, 10) : id);

  try {
    // Verify user is recipient of all messages
    const verifyResult = await db.query(
      `SELECT id FROM chat_messages 
       WHERE id = ANY($1::bigint[])
       AND (
         recipient_type = 'game'
         OR (recipient_type = 'player' AND recipient_id = $2)
       )
       AND sender_user_id != $2`,
      [numericIds, user.id]
    );

    if (verifyResult.rows.length !== uniqueMessageIds.length) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You can only mark your own received messages as read'
      });
      return;
    }

    await ChatService.markAsRead(numericIds);

    res.status(200).json({
      success: true,
      message: 'Messages marked as read'
    });
  } catch (error) {
    console.error('Mark messages as read error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to mark messages as read',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * GET /api/chat/players/:gameId
 * Get all players in a game (for chat UI)
 */
router.get('/players/:gameId', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { gameId } = req.params;

  try {
    // Verify user is in the game
    const playerResult = await db.query(
      'SELECT id FROM players WHERE game_id = $1 AND user_id = $2 AND is_deleted = false',
      [gameId, user.id]
    );

    if (playerResult.rows.length === 0) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You are not in this game'
      });
      return;
    }

    const players = await ChatService.getGamePlayers(gameId);

    res.status(200).json({
      success: true,
      data: { players },
      message: 'Players retrieved successfully'
    });
  } catch (error) {
    console.error('Get game players error:', error);
    
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to get game players',
      details: 'An unexpected error occurred'
    });
  }
}));

/**
 * GET /api/chat/health
 * Health check endpoint for chat services including moderation
 */
router.get('/health', asyncHandler(async (req: Request, res: Response) => {
  const moderationStatus = moderationService.getHealthStatus();
  
  res.status(200).json({
    success: true,
    message: 'Chat service health check',
    data: {
      moderation: {
        initialized: moderationStatus.initialized,
        provider: moderationStatus.provider,
        modelName: moderationStatus.modelName,
      },
      service: 'chat-api',
      timestamp: new Date().toISOString(),
    }
  });
}));

export default router;
