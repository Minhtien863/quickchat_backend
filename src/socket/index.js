// src/socket/index.js
import jwt from 'jsonwebtoken';
import { sendIncomingCallPush } from '../services/fcm.service.js';
import { pool } from '../db.js';
import { activeCalls } from './active-calls.js';
let ioInstance = null;

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.JWT_ACCESS_SECRET ||
  process.env.JWT_ACCESS_TOKEN_SECRET ||
  null;

export function attachSocket(io) {
  ioInstance = io;

  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.headers['authorization'] || '';
      const token = raw.replace('Bearer ', '').trim();
      if (!token) return next(new Error('no auth'));

      // Không có secret → DEV fallback (decode thôi)
      if (!JWT_SECRET) {
        socket.user = jwt.decode(token);
        console.warn(
          '[SOCKET] WARNING: JWT secret not configured, using jwt.decode() (DEV only)',
        );
        return next();
      }

      // Verify chữ ký, BỎ qua hạn
      const payload = jwt.verify(token, JWT_SECRET, {
        ignoreExpiration: true,
      });

      // Check token_version giống HTTP
      const { rows } = await pool.query(
        'SELECT token_version FROM users WHERE id = $1',
        [payload.sub],
      );
      if (!rows.length) {
        return next(new Error('user_not_found'));
      }
      const currentVersion = rows[0].token_version ?? 0;
      if ((payload.tv ?? 0) !== currentVersion) {
        return next(new Error('token_revoked'));
      }

      socket.user = payload; // { sub, email, tv, ... }
      next();
    } catch (err) {
      console.error('[SOCKET] auth error:', err.message);
      next(new Error('bad auth'));
    }
  });

  io.on('connection', (socket) => {
  const userId = socket.user?.sub || socket.user?.id || null;
  console.log('[SOCKET] client connected, userId =', userId);

  if (userId) {
    socket.join(`user:${userId}`);
    console.log('[SOCKET] join room', `user:${userId}`);
  }

  // Join/leave room hội thoại
  socket.on('room:join', ({ conversationId }) => {
    if (!conversationId) return;
    socket.join(`conv:${conversationId}`);
    console.log('[SOCKET] room:join', conversationId, 'by user', userId);

    // Nếu đang có cuộc gọi active cho hội thoại này,
    // và socket này KHÔNG phải người gọi -> gửi lại OFFER
    const current = activeCalls.get(conversationId);
    if (current && current.fromUserId !== userId) {
      console.log('[SOCKET] resend offer to newly joined user', userId);
      socket.emit('call:offer', {
        fromUserId: current.fromUserId,
        conversationId,
        sdp: current.sdp,
        type: current.type,
        kind: current.kind,
      });
    }
  });

  socket.on('room:leave', ({ conversationId }) => {
    if (!conversationId) return;
    console.log('[SOCKET] room:leave', conversationId, 'by user', userId);
    socket.leave(`conv:${conversationId}`);
  });

// ================== CALL RING - SOCKET RIÊNG ==================
socket.on('call:ring', async ({ conversationId, kind, targetUserId }) => {
  if (!conversationId || !kind) return;

  console.log(
    '[SOCKET] call:ring from',
    userId,
    'conv=',
    conversationId,
    'kind=',
    kind,
  );

  // Lưu tạm active call (chưa SDP)
  activeCalls.set(conversationId, {
    fromUserId: userId,
    sdp: null,
    type: null,
    kind: kind || 'voice',
  });

  try {
    // 1) Lấy tất cả thành viên khác caller
    const { rows: memberRows } = await pool.query(
      `SELECT user_id 
       FROM conversation_members 
       WHERE conversation_id = $1 AND user_id <> $2`,
      [conversationId, userId],
    );
    const recipientIds = memberRows.map((r) => r.user_id);
    if (recipientIds.length === 0) {
      console.log('[SOCKET] call:ring - no recipients');
      return;
    }

    // 2) Lọc block 2 chiều (giống trong sendIncomingCallPush)
    const { rows: allowedRows } = await pool.query(
      `SELECT id 
       FROM users 
       WHERE id = ANY($1::uuid[])
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.user_id = $2 AND b.target_user_id = id)
              OR (b.user_id = id AND b.target_user_id = $2)
         )`,
      [recipientIds, userId],
    );
    const allowedRecipientIds = allowedRows.map((r) => r.id);
    if (allowedRecipientIds.length === 0) {
      console.log('[SOCKET] call:ring - all recipients blocked');
      return;
    }

    // 3) BẮN call:incoming cho từng user:<id> để CallSignalingService nhận được
    for (const peerId of allowedRecipientIds) {
      io.to(`user:${peerId}`).emit('call:incoming', {
        fromUserId: userId,
        conversationId,
        kind,
      });
    }
  } catch (err) {
    console.error('call:ring error:', err);
  }
});
    // ===== WebRTC signaling cho call / video call =====

        // Caller gửi OFFER
    socket.on('call:offer', async ({ conversationId, sdp, type, kind }) => {
      if (!conversationId || !sdp || !type) return;

      console.log(
        '[SOCKET] call:offer from',
        userId,
        'conv =',
        conversationId,
        'kind =',
        kind,
      );

      let peerIds = [];

      try {
        // Lấy toàn bộ thành viên của cuộc trò chuyện
        const { rows: memberRows } = await pool.query(
          `
          SELECT user_id
          FROM conversation_members
          WHERE conversation_id = $1
          `,
          [conversationId],
        );

        if (!memberRows.length) {
          console.warn('[SOCKET] call:offer - no members in conversation');
          socket.emit('call:error', {
            code: 'CONVERSATION_NOT_FOUND',
            message: 'Không tìm thấy cuộc trò chuyện.',
          });
          return;
        }

        const memberIds = memberRows.map((r) => r.user_id);

        // Caller phải thuộc conversation
        if (!memberIds.some((id) => id === userId)) {
          console.warn('[SOCKET] call:offer - user not in conversation');
          socket.emit('call:error', {
            code: 'NOT_IN_CONVERSATION',
            message: 'Bạn không thuộc cuộc trò chuyện này.',
          });
          return;
        }

        // Các peer còn lại (không bao gồm caller)
        peerIds = memberIds.filter((id) => id !== userId);

        // Nếu không có ai để gọi thì thôi
        if (peerIds.length === 0) {
          console.log(
            '[SOCKET] call:offer - no peers (only caller in conversation)',
          );
          socket.emit('call:error', {
            code: 'NO_RECIPIENT',
            message: 'Không có người nhận cuộc gọi.',
          });
          return;
        }

        // Check block 2 chiều với từng peer
        for (const peerId of peerIds) {
          const { rows: blockRows } = await pool.query(
            `
            SELECT 1
            FROM user_blocks
            WHERE (user_id = $1 AND target_user_id = $2)
               OR (user_id = $2 AND target_user_id = $1)
            LIMIT 1
            `,
            [userId, peerId],
          );

          if (blockRows.length > 0) {
            console.log(
              '[SOCKET] call:offer blocked between',
              userId,
              'and',
              peerId,
            );
            socket.emit('call:error', {
              code: 'BLOCKED',
              message:
                'Không thể thực hiện cuộc gọi vì hai bạn đang chặn nhau.',
            });
            return;
          }
        }
      } catch (err) {
        console.error('[SOCKET] call:offer members/block query error:', err);
        socket.emit('call:error', {
          code: 'INTERNAL',
          message:
            'Không thể bắt đầu cuộc gọi vì lỗi hệ thống. Vui lòng thử lại sau.',
        });
        return;
      }

      // Nếu qua được hết check -> lưu offer đang active
      activeCalls.set(conversationId, {
        fromUserId: userId,
        sdp,
        type,
        kind: kind || 'voice',
      });

      // Gửi offer qua socket cho các peer trong room hội thoại
      socket.to(`conv:${conversationId}`).emit('call:offer', {
        fromUserId: userId,
        conversationId,
        sdp,
        type,
        kind,
      });

      // Gửi FCM incoming_call, có kèm SDP nếu không quá dài
      try {
        await sendIncomingCallPush({
          conversationId,
          fromUserId: userId,
          kind: kind || 'voice',
          sdp,
          sdpType: type,
        });
      } catch (err) {
        console.error('sendIncomingCallPush error:', err);
      }
    });

    // Callee gửi ANSWER
    socket.on('call:answer', ({ conversationId, sdp, type }) => {
      console.log('[SOCKET] call:answer from', userId, 'conv =', conversationId);
      if (!conversationId || !sdp || !type) return;
      socket.to(`conv:${conversationId}`).emit('call:answer', {
        fromUserId: userId,
        conversationId,
        sdp,
        type,
      });
    });

    // ICE candidate 2 chiều
    socket.on('call:ice-candidate', ({ conversationId, candidate }) => {
      if (!conversationId || !candidate) return;
      socket.to(`conv:${conversationId}`).emit('call:ice-candidate', {
        fromUserId: userId,
        conversationId,
        candidate,
      });
    });

    // Hangup
    socket.on('call:hangup', ({ conversationId }) => {
      if (!conversationId) return;

      console.log('[SOCKET] call:hangup from', userId, 'conv =', conversationId);

      // Xoá OFFER đang cache cho cuộc gọi này
      activeCalls.delete(conversationId);

      socket.to(`conv:${conversationId}`).emit('call:hangup', {
        fromUserId: userId,
        conversationId,
      });
    });

    socket.on('disconnect', (reason) => {
      console.log('[SOCKET] client disconnected', userId, 'reason =', reason);
    });
  });
}

export function getIO() {
  if (!ioInstance) {
    throw new Error('Socket.io not initialized');
  }
  return ioInstance;
}

// Helper bắn event đến 1 user
export function emitToUser(userId, event, payload = {}) {
  if (!ioInstance || !userId) return;
  console.log('[SOCKET] emitToUser ->', userId, 'event =', event);
  ioInstance.to(`user:${userId}`).emit(event, payload);
}
