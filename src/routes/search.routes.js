import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import {
  searchGlobal,
  searchConversationMessages,
} from '../controllers/search.controller.js';

const router = Router();

// Search toàn bộ (People + Messages)
router.get('/global', authRequired, searchGlobal);

// Search trong 1 hội thoại
router.get('/conversation/:conversationId', authRequired, searchConversationMessages);

export default router;
