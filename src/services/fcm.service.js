// src/services/fcm.service.js
import admin from 'firebase-admin';
import { createRequire } from 'module';
import { pool } from '../db.js';

const require = createRequire(import.meta.url);

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.error('[FCM] Lỗi parse FIREBASE_SERVICE_ACCOUNT_JSON:', e);
  }
}
if (!serviceAccount) {
  try {
    serviceAccount = require('../config/firebase-service-account.json');
  } catch (e) {
    console.error(
      '[FCM] Không tìm thấy firebase-service-account.json và cũng không có FIREBASE_SERVICE_ACCOUNT_JSON'
    );
    throw e;
  }
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// ========== 1) Đăng ký thiết bị: 1 user chỉ 1 thiết bị ==========
// Đồng thời đảm bảo 1 token FCM không thuộc về 2 user khác nhau
export async function registerDeviceToken({
  userId,
  fcmToken,
  platform,
  deviceModel,
  appVersion,
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lấy token cũ (nếu có) để tí nữa gửi force_logout
    const prevRes = await client.query(
      `
      SELECT fcm_token
      FROM user_devices
      WHERE user_id = $1
      FOR UPDATE
      `,
      [userId],
    );

    let oldToken = null;
    if (prevRes.rowCount > 0) {
      oldToken = prevRes.rows[0].fcm_token;
    }

    // 1) Xóa bất kỳ user nào khác đang dùng cùng FCM token này
    await client.query(
      `
      DELETE FROM user_devices
      WHERE user_id <> $1
        AND fcm_token = $2
      `,
      [userId, fcmToken],
    );

    // 2) Xóa hết device cũ của user này (chỉ cho 1 device / user)
    await client.query(
      `
      DELETE FROM user_devices
      WHERE user_id = $1
      `,
      [userId],
    );

    // 3) Tạo bản ghi mới cho device hiện tại
    await client.query(
      `
      INSERT INTO user_devices (
        user_id, fcm_token, platform, device_model, app_version, is_active
      )
      VALUES ($1, $2, $3, $4, $5, true)
      `,
      [userId, fcmToken, platform, deviceModel, appVersion],
    );

    await client.query('COMMIT');

    // Sau khi commit: nếu có oldToken khác fcmToken hiện tại -> đá device cũ
    if (oldToken && oldToken !== fcmToken) {
      try {
        const msg = {
          tokens: [oldToken],
          data: {
            type: 'force_logout',
            message: 'Tài khoản của bạn đã đăng nhập trên thiết bị khác',
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'quickchat_default',
              clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            },
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                category: 'LOGOUT',
              },
            },
          },
        };

        await admin.messaging().sendEachForMulticast(msg);
        console.log('[FCM] Đã gửi force_logout tới', oldToken);
      } catch (e) {
        console.error('[FCM] Lỗi gửi force_logout:', e);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('registerDeviceToken error:', err);
    throw err;
  } finally {
    client.release();
  }
}

// ========== 2) Helper lấy token active để gửi push tin nhắn/cuộc gọi ==========

async function getActiveTokensForUsers(userIds, settingColumn) {
  if (!userIds || userIds.length === 0) return [];

  const { rows } = await pool.query(
    `
    SELECT DISTINCT ud.fcm_token
    FROM user_devices ud
    LEFT JOIN user_notification_settings ns
      ON ns.user_id = ud.user_id
    WHERE ud.user_id = ANY($1::uuid[])
      AND ud.is_active = true
      AND COALESCE(ns.${settingColumn}, true) = true
    `,
    [userIds],
  );

  return rows.map((r) => r.fcm_token).filter(Boolean);
}

// ========== 3) Push cho tin nhắn mới ==========

export async function sendChatMessagePush({
  conversationId,
  senderId,
  preview,
}) {
  try {
    // Thông tin hội thoại
    const { rows: convRows } = await pool.query(
      `
      SELECT
        c.id,
        c.type,
        COALESCE(gp.name, c.title) AS title
      FROM conversations c
      LEFT JOIN group_profiles gp
        ON gp.conversation_id = c.id
      WHERE c.id = $1
      `,
      [conversationId],
    );
    if (convRows.length === 0) return;

    const conv = convRows[0];
    const convType = conv.type; // 'direct' | 'group'
    const convTitle = conv.title;

    // Người gửi
    const { rows: senderRows } = await pool.query(
      `
      SELECT id, COALESCE(display_name, email, username) AS name
      FROM users
      WHERE id = $1
      `,
      [senderId],
    );
    const senderName = senderRows[0]?.name || 'Người dùng QuickChat';

    // Thành viên nhận (trừ người gửi)
    const { rows: memberRows } = await pool.query(
      `
      SELECT user_id
      FROM conversation_members
      WHERE conversation_id = $1
        AND user_id <> $2
      `,
      [conversationId, senderId],
    );
    const recipientIds = memberRows.map((r) => r.user_id);
    if (recipientIds.length === 0) return;

    const settingColumn =
      convType === 'group' ? 'group_push_enabled' : 'dm_push_enabled';

    const tokens = await getActiveTokensForUsers(recipientIds, settingColumn);
    if (tokens.length === 0) return;

    const title =
      convType === 'group' ? convTitle || 'Tin nhắn nhóm mới' : senderName;

    const body =
      (preview && preview.toString().trim()) ||
      (convType === 'group'
        ? `${senderName}: Bạn có tin nhắn mới`
        : 'Bạn có tin nhắn mới');

    const message = {
      tokens,
      notification: { title, body },
      data: {
        type: 'chat_message',
        conversationId: conversationId,
        conversationType: convType,
        title,
        senderId: String(senderId),
        bodyPreview: body,
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'quickchat_default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            category: 'MESSAGE',
          },
        },
      },
    };

    await admin.messaging().sendEachForMulticast(message);
  } catch (err) {
    console.error('sendChatMessagePush error:', err);
  }
}
// ========== 4) Push cho cuộc gọi đến ==========
// src/services/fcm.service.js

export async function sendIncomingCallPush({
  conversationId,
  fromUserId,
  kind,
  sdp,
  sdpType,
}) {
  try {
    const callKind = kind === 'video' ? 'video' : 'voice';

    // 1) Thông tin người gọi
    const { rows: callerRows } = await pool.query(
      `
      SELECT 
        u.id, 
        COALESCE(u.display_name, u.email, u.username) AS name, 
        a.url AS avatar_url
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE u.id = $1
      `,
      [fromUserId],
    );
    if (callerRows.length === 0) return;
    const caller = callerRows[0];

    // 2) Lấy danh sách người nhận (trừ caller) + lọc block 2 chiều
    const { rows: memberRows } = await pool.query(
      `
      SELECT user_id 
      FROM conversation_members 
      WHERE conversation_id = $1 
        AND user_id <> $2
      `,
      [conversationId, fromUserId],
    );
    const recipientIds = memberRows.map((r) => r.user_id);
    if (recipientIds.length === 0) return;

    const { rows: allowedRows } = await pool.query(
      `
      SELECT id 
      FROM users 
      WHERE id = ANY($1::uuid[])
        AND NOT EXISTS (
          SELECT 1 
          FROM user_blocks b
          WHERE (b.user_id = $2 AND b.target_user_id = id)
             OR (b.user_id = id AND b.target_user_id = $2)
        )
      `,
      [recipientIds, fromUserId],
    );
    const allowedRecipientIds = allowedRows.map((r) => r.id);
    if (allowedRecipientIds.length === 0) return;

    // 3) Lấy FCM tokens cho những user còn lại
    const tokens = await getActiveTokensForUsers(
      allowedRecipientIds,
      'call_push_enabled',
    );
    if (tokens.length === 0) {
      console.log('[FCM-CALL] Không có token nào cho incoming_call');
      return;
    }

    console.log('[FCM-CALL] tokens cho incoming_call:', tokens);

    // 4) Data FCM: đủ để mở màn hình incoming call + SDP nếu không quá dài
    const data = {
      type: 'incoming_call',
      conversationId: String(conversationId),
      kind: callKind,
      peerId: String(caller.id),
      peerName: caller.name || '',
      avatarUrl: caller.avatar_url || '',
    };

    // Gửi kèm SDP nếu độ dài hợp lý, tránh vượt limit 4KB của FCM
    if (sdp && sdpType) {
      const sdpStr = String(sdp);
      if (sdpStr.length < 2500) {
        data.sdp = sdpStr;
        data.remoteOfferType = String(sdpType);
      } else {
        console.warn(
          '[FCM-CALL] SDP quá dài, bỏ qua trong FCM. length =',
          sdpStr.length,
        );
      }
    }

    const message = {
      tokens,
      notification: {
        title: caller.name || 'Cuộc gọi đến',
        body: `${caller.name} đang gọi ${
          callKind === 'video' ? 'video' : 'thoại'
        }...`,
      },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'call_channel',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          sound: 'default',
          visibility: 'public',
        },
      },
      apns: {
        payload: {
          aps: {
            category: 'INCOMING_CALL',
            sound: 'default',
            'mutable-content': 1,
          },
        },
      },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(
      '[FCM-CALL] incoming_call success =',
      response.successCount,
      'failure =',
      response.failureCount,
    );

    response.responses.forEach((r, idx) => {
      if (!r.success) {
        console.error(
          '[FCM-CALL] token lỗi:',
          tokens[idx],
          r.error?.code,
          r.error?.message,
        );
      }
    });
  } catch (err) {
    console.error('sendIncomingCallPush error:', err);
  }
}

export async function sendForceLogoutToUser({ userId, reason, message }) {
  try {
    console.log('[FCM] sendForceLogoutToUser userId =', userId);

    const q = `
      SELECT fcm_token
      FROM user_devices
      WHERE user_id = $1
        AND fcm_token IS NOT NULL
    `;
    const r = await pool.query(q, [userId]);
    console.log('[FCM] user_devices rows =', r.rowCount);

    if (!r.rowCount) return;

    const tokens = r.rows.map(row => row.fcm_token).filter(Boolean);
    console.log('[FCM] tokens for force_logout =', tokens);

    if (!tokens.length) return;

    const data = {
      type: 'force_logout',
      reason: reason || '',
      message: message || '',
    };

    const msg = {
      tokens,
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'quickchat_default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            category: 'LOGOUT',
          },
        },
      },
    };

    const resp = await admin.messaging().sendEachForMulticast(msg);
    console.log(
      '[FCM] force_logout success =',
      resp.successCount,
      'failure =',
      resp.failureCount,
    );
    resp.responses.forEach((r, idx) => {
      if (!r.success) {
        console.error(
          '[FCM] force_logout token lỗi:',
          tokens[idx],
          r.error?.code,
          r.error?.message,
        );
      }
    });
  } catch (e) {
    console.error('[FCM] sendForceLogoutToUser error:', e);
  }
}