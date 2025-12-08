// src/routes/notes.routes.js
import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import {
  getMyNote,
  upsertMyNote,
  getNotesFeed,
  deleteMyNote,
  markNoteViewed,
  setNoteReaction,
  getNoteActivity,
  listNoteNotifications,
  markNoteNotificationRead,
} from '../controllers/notes.controller.js';

const router = Router();

router.use(authRequired);

// Ghi chú của chính mình
router.get('/my', getMyNote);
router.post('/my', upsertMyNote);
router.delete('/my', deleteMyNote);

// Feed ghi chú
router.get('/feed', getNotesFeed);

// Thông báo về ghi chú
router.get('/notifications', listNoteNotifications);
router.post('/notifications/:id/read', markNoteNotificationRead);

// Hoạt động & reaction
// POST /api/notes/:id/view  – ghi nhận đã xem
router.post('/:id/view', markNoteViewed);

// POST /api/notes/:id/reaction – set reaction mới nhất
router.post('/:id/reaction', setNoteReaction);

// GET /api/notes/:id/activity – danh sách xem + reaction
router.get('/:id/activity', getNoteActivity);

export default router;
