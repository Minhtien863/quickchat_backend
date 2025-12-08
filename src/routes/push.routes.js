// src/routes/push.routes.js
import { Router } from 'express';
import { authRequired } from '../middlewares/auth.middleware.js';
import {
  registerFcmToken,
  getMyNotificationSettings,
  updateMyNotificationSettings,
} from '../controllers/push.controller.js';

const router = Router();

router.use(authRequired);

router.post('/fcm-token', registerFcmToken);
router.get('/settings', getMyNotificationSettings);
router.patch('/settings', updateMyNotificationSettings);

export default router;