// src/routes/notifications.routes.js
import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import { touchLastSeen } from '../middlewares/lastSeen.middleware.js';
import { listAppNotifications, markAppNotificationRead } from '../controllers/notifications.controller.js';

const router = Router();

router.use(authRequired, touchLastSeen);
router.get('/', listAppNotifications);
router.post('/:id/read', markAppNotificationRead);

export default router;