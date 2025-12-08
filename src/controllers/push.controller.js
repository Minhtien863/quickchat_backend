// src/controllers/push.controller.js
import { registerDeviceToken } from '../services/fcm.service.js';
import { pool } from '../db.js';

export async function registerFcmToken(req, res) {
  try {
    const userId = req.user.sub;
    const { fcmToken, platform, deviceModel, appVersion } = req.body || {};

    if (!fcmToken || typeof fcmToken !== 'string') {
      return res.status(400).json({ error: 'fcmToken is required' });
    }

    await registerDeviceToken({
      userId,
      fcmToken,
      platform: platform || 'unknown',
      deviceModel: deviceModel || null,
      appVersion: appVersion || null,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('registerFcmToken error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getMyNotificationSettings(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    await pool.query(
      `
      INSERT INTO user_notification_settings (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId],
    );

    const rs = await pool.query(
      `
      SELECT dm_push_enabled, group_push_enabled, call_push_enabled
      FROM user_notification_settings
      WHERE user_id = $1
      `,
      [userId],
    );

    if (rs.rowCount === 0) {
      return res.json({
        dmPushEnabled: true,
        groupPushEnabled: true,
        callPushEnabled: true,
      });
    }

    const row = rs.rows[0];

    return res.json({
      dmPushEnabled: row.dm_push_enabled ?? true,
      groupPushEnabled: row.group_push_enabled ?? true,
      callPushEnabled: row.call_push_enabled ?? true,
    });
  } catch (err) {
    console.error('getMyNotificationSettings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateMyNotificationSettings(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const {
      dmPushEnabled,
      groupPushEnabled,
      callPushEnabled,
    } = req.body || {};

    const rs = await pool.query(
      `
      INSERT INTO user_notification_settings (
        user_id,
        dm_push_enabled,
        group_push_enabled,
        call_push_enabled
      )
      VALUES (
        $1,
        COALESCE($2, true),
        COALESCE($3, true),
        COALESCE($4, true)
      )
      ON CONFLICT (user_id) DO UPDATE SET
        dm_push_enabled    = COALESCE($2, user_notification_settings.dm_push_enabled),
        group_push_enabled = COALESCE($3, user_notification_settings.group_push_enabled),
        call_push_enabled  = COALESCE($4, user_notification_settings.call_push_enabled)
      RETURNING
        dm_push_enabled,
        group_push_enabled,
        call_push_enabled
      `,
      [
        userId,
        typeof dmPushEnabled === 'boolean' ? dmPushEnabled : null,
        typeof groupPushEnabled === 'boolean' ? groupPushEnabled : null,
        typeof callPushEnabled === 'boolean' ? callPushEnabled : null,
      ],
    );

    const row = rs.rows[0];

    return res.json({
      dmPushEnabled: row.dm_push_enabled ?? true,
      groupPushEnabled: row.group_push_enabled ?? true,
      callPushEnabled: row.call_push_enabled ?? true,
    });
  } catch (err) {
    console.error('updateMyNotificationSettings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}