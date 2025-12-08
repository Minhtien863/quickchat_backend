import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import {
  listConversations,
  openDirectConversation,
  markConversationRead,
  markConversationUnread,
  clearConversationHistory,
} from '../controllers/conversations.controller.js';
import { touchLastSeen } from '../middlewares/lastSeen.middleware.js';

const router = Router();

// GET /api/chat/conversations
router.get(
  '/conversations',
  authRequired,
  touchLastSeen,
  listConversations,
);

// POST /api/chat/direct/open
router.post(
  '/direct/open',
  authRequired,
  touchLastSeen,
  openDirectConversation,
);

// POST /api/chat/conversations/:id/read
router.post(
  '/conversations/:id/read',
  authRequired,
  touchLastSeen,
  markConversationRead,
);

// POST /api/chat/conversations/:id/unread
router.post(
  '/conversations/:id/unread',
  authRequired,
  touchLastSeen,
  markConversationUnread,
);

router.delete(
  '/conversations/:conversationId/history',
  authRequired,
  touchLastSeen,
  clearConversationHistory,
);

export default router;