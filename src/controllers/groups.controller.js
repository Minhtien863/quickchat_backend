// src/controllers/groups.controller.js
import { pool } from '../db.js';
import { uploadBufferToCloudinary } from '../config/cloudinary.js';
import sharp from 'sharp';

// Tạo avatar nhóm tự động từ avatar các thành viên
async function generateGroupAutoAvatar(client, memberIds) {
  // Lấy tối đa 4 avatar url của các thành viên
  const { rows } = await client.query(
    `
    SELECT a.url
    FROM users u
    LEFT JOIN assets a ON a.id = u.avatar_asset_id
    WHERE u.id = ANY($1::uuid[])
      AND a.url IS NOT NULL
    `,
    [memberIds],
  );

  const urls = rows.map(r => r.url).filter(Boolean);
  if (!urls.length) {
    // Không có avatar nào -> chịu, để null, frontend fallback như hiện tại
    return { avatarAssetId: null, avatarUrl: null };
  }

  // Shuffle ngẫu nhiên rồi lấy tối đa 4
  const shuffled = [...urls];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(0, 4);

  // Kích thước ảnh ghép
  const size = 512;      // ảnh vuông 512x512
  const cell = size / 2; // 256

  // Tải buffer từng avatar
  const avatarBuffers = [];
  for (const url of picked) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const arrBuf = await resp.arrayBuffer();
      const buf = Buffer.from(arrBuf);
      avatarBuffers.push(buf);
    } catch (e) {
      console.error('generateGroupAutoAvatar fetch error:', e);
    }
  }

  if (!avatarBuffers.length) {
    return { avatarAssetId: null, avatarUrl: null };
  }

  // Tạo canvas trống
  const base = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: '#e5e7eb', // xám nhạt
    },
  });

  const composites = [];
  const n = avatarBuffers.length;

  if (n === 1) {
    // 1 avatar: full 100%
    const buf = await sharp(avatarBuffers[0])
      .resize(size, size)
      .toBuffer();
    composites.push({
      input: buf,
      left: 0,
      top: 0,
    });
  } else if (n === 2) {
    // 2 avatar: mỗi cái 50% chiều ngang (left/right)
    for (let i = 0; i < 2; i++) {
      const resized = await sharp(avatarBuffers[i])
        .resize(cell, size)
        .toBuffer();
      composites.push({
        input: resized,
        left: i * cell, // 0 và 256
        top: 0,
      });
    }
  } else if (n === 3) {
    // 3 avatar:
    // - avatarBuffers[0] chiếm 50% (trái, full height)
    // - avatarBuffers[1], [2] mỗi cái 25% (phải trên, phải dưới)
    const big = await sharp(avatarBuffers[0])
      .resize(cell, size)
      .toBuffer();
    composites.push({
      input: big,
      left: 0,
      top: 0,
    });

    const small1 = await sharp(avatarBuffers[1])
      .resize(cell, cell)
      .toBuffer();
    composites.push({
      input: small1,
      left: cell,
      top: 0,
    });

    const small2 = await sharp(avatarBuffers[2])
      .resize(cell, cell)
      .toBuffer();
    composites.push({
      input: small2,
      left: cell,
      top: cell,
    });
  } else {
    // 4 avatar trở lên: 2x2 grid như cũ
    for (let i = 0; i < 4; i++) {
      const resized = await sharp(avatarBuffers[i])
        .resize(cell, cell)
        .toBuffer();
      const row = Math.floor(i / 2);
      const col = i % 2;
      composites.push({
        input: resized,
        left: col * cell,
        top: row * cell,
      });
    }
  }

  const pngBuffer = await base
    .composite(composites)
    .png()
    .toBuffer();

  // Upload lên Cloudinary
  const cld = await uploadBufferToCloudinary(pngBuffer, {
    folder: 'groups/auto',
    resource_type: 'image',
  });

  // Lưu vào bảng assets
  const a = await client.query(
    `INSERT INTO assets (kind, url)
     VALUES ('image', $1)
     RETURNING id, url`,
    [cld.secure_url],
  );

  return {
    avatarAssetId: a.rows[0].id,
    avatarUrl: a.rows[0].url,
  };
}


// POST /api/groups
export async function createGroup(req, res) {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  // ---- đọc input
  const rawTitle = (req.body?.title ?? '').trim();

  let memberIds = [];
  try {
    const raw = req.body?.memberIds;
    if (Array.isArray(raw)) memberIds = raw;
    else if (typeof raw === 'string' && raw.length) memberIds = JSON.parse(raw);
  } catch (_) {
    memberIds = [];
  }

  // loại trùng + loại chính mình, rồi thêm creator vào đầu (owner luôn đứng đầu)
  const unique = [...new Set(memberIds.filter(id => id && id !== userId))];
  const finalMembers = [userId, ...unique];
  if (finalMembers.length < 2) {
    return res.status(400).json({ message: 'Cần ít nhất 1 thành viên khác' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- upload avatar nếu có
    let avatarAssetId = null;
    let avatarUrl = null;

    if (req.file && req.file.buffer) {
      // Người dùng upload avatar nhóm
      const up = await uploadBufferToCloudinary(req.file.buffer, {
        folder: 'groups',
        resource_type: 'image',
      });
      const a = await client.query(
        `INSERT INTO assets (kind, url)
         VALUES ('image', $1)
         RETURNING id, url`,
        [up.secure_url],
      );
      avatarAssetId = a.rows[0].id;
      avatarUrl = a.rows[0].url;
    } else {
      // Không upload avatar -> tự sinh avatar từ avatar thành viên
      const auto = await generateGroupAutoAvatar(client, finalMembers);
      avatarAssetId = auto.avatarAssetId;
      avatarUrl = auto.avatarUrl;
    }

    // ---- tạo title mặc định nếu không có title đầu vào
    let title = rawTitle;
    if (!title) {
      const rs = await client.query(
        `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`,
        [finalMembers],
      );
      const users = rs.rows;

      const owner = users.find(u => u.id === userId);
      const others = users.filter(u => u.id !== userId);

      // Rút gọn tên: luôn lấy 2 từ cuối; nếu chỉ có 1 từ thì giữ nguyên
      const short2 = full => {
        const parts = String(full || 'User')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (parts.length <= 2) return parts.join(' ');
        return parts.slice(-2).join(' ');
      };

      // Shuffle others
      for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
      }

      // Tổng số tên hiển thị: 2..4 (không vượt số thành viên)
      const maxShow = Math.min(4, users.length);
      const wantedTotal = Math.max(2, Math.min(4, maxShow));
      const needOthers = Math.min(others.length, wantedTotal - 1);

      const pickedUsers = [owner, ...others.slice(0, needOthers)].filter(Boolean);

      title = pickedUsers.map(p => short2(p.display_name)).join(', ').trim();
      if (!title) title = 'Nhóm mới';
    }

    // ---- tạo conversation group
    const c = await client.query(
      `INSERT INTO conversations (type, title, avatar_asset_id)
       VALUES ('group', $1, $2)
       RETURNING id, title`,
      [title, avatarAssetId],
    );
    const conversationId = c.rows[0].id;

    // ---- thêm members (creator = owner, còn lại member)
    const values = [];
    const params = [];
    let i = 1;
    for (let idx = 0; idx < finalMembers.length; idx++) {
      const role = idx === 0 ? 'owner' : 'member';
      params.push(conversationId, finalMembers[idx], role);
      values.push(`($${i++}, $${i++}, $${i++})`);
    }
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ${values.join(',')}`,
      params,
    );

    await client.query('COMMIT');
    return res.status(201).json({ conversationId, title, avatarUrl });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('createGroup error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}
// Helper: lấy type conversation + role của current user
async function getConversationAndMyRole(client, conversationId, userId) {
  const convRes = await client.query(
    'SELECT id, type FROM conversations WHERE id = $1',
    [conversationId],
  );
  if (!convRes.rows.length) {
    return { exists: false };
  }
  const conv = convRes.rows[0];
  if (conv.type !== 'group') {
    return { exists: true, isGroup: false };
  }

  const memRes = await client.query(
    `SELECT role FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  if (!memRes.rows.length) {
    // không phải thành viên
    return { exists: true, isGroup: true, isMember: false };
  }

  return {
    exists: true,
    isGroup: true,
    isMember: true,
    myRole: memRes.rows[0].role,
  };
}

// GET /api/groups/:conversationId/members
export async function listGroupMembers(req, res) {
  const userId = req.user?.sub;
  const { conversationId } = req.params;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    const info = await getConversationAndMyRole(client, conversationId, userId);
    if (!info.exists) {
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!info.isGroup) {
      return res.status(400).json({ message: 'Not a group conversation' });
    }
    if (!info.isMember) {
      return res.status(403).json({ message: 'You are not a member of this group' });
    }

    const { rows } = await client.query(
      `
      SELECT
        cm.user_id,
        cm.role,
        cm.is_muted,
        u.display_name,
        a.url AS avatar_url
      FROM conversation_members cm
      JOIN users u ON u.id = cm.user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE cm.conversation_id = $1
      ORDER BY
        (cm.role = 'owner') DESC,
        (cm.role = 'admin') DESC,
        LOWER(u.display_name)
      `,
      [conversationId],
    );

    const members = rows.map(r => ({
      id: r.user_id,
      displayName: r.display_name || 'Người dùng',
      role: r.role,
      avatarUrl: r.avatar_url || null,
      isYou: r.user_id === userId,
      // is_muted = true -> không được gửi, canSend = false
      canSend: !r.is_muted,
    }));

    const my = members.find(m => m.isYou);
    const myRole = my?.role ?? info.myRole ?? 'member';

    return res.json({
      conversationId,
      myRole,
      members,
    });
  } catch (err) {
    console.error('listGroupMembers error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

// POST /api/groups/:conversationId/members
// body: { userIds: [uuid, ...] }
export async function addGroupMembers(req, res) {
  const userId = req.user?.sub;
  const { conversationId } = req.params;
  const rawIds = req.body?.userIds;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  let userIds = [];
  if (Array.isArray(rawIds)) {
    userIds = rawIds
      .map(x => String(x).trim())
      .filter(x => x.length > 0);
  }

  if (!userIds.length) {
    return res.status(400).json({ message: 'Danh sách thành viên thêm trống' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const info = await getConversationAndMyRole(client, conversationId, userId);
    if (!info.exists) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!info.isGroup) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Not a group conversation' });
    }
    if (!info.isMember) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You are not a member of this group' });
    }
    if (info.myRole !== 'owner' && info.myRole !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Only owner/admin can add members' });
    }

    // Loại bỏ trùng + chính mình
    const unique = [...new Set(userIds.filter(id => id !== userId))];
    if (!unique.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Không có thành viên hợp lệ để thêm' });
    }

    // Chỉ thêm user tồn tại + chưa là member
    const existRes = await client.query(
      `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
      [unique],
    );
    const existIds = existRes.rows.map(r => r.id);

    if (!existIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Không tìm thấy người dùng hợp lệ để thêm' });
    }

    const values = [];
    const params = [];
    let i = 1;
    for (const uid of existIds) {
      params.push(conversationId, uid, 'member');
      values.push(`($${i++}, $${i++}, $${i++})`);
    }

    await client.query(
      `
      INSERT INTO conversation_members (conversation_id, user_id, role)
      VALUES ${values.join(',')}
      ON CONFLICT (conversation_id, user_id) DO NOTHING
      `,
      params,
    );

    await client.query('COMMIT');
    return res.status(200).json({ added: existIds.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('addGroupMembers error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

// PATCH /api/groups/:conversationId/members/:userId/role
// body: { role: 'owner'|'admin'|'member' }
export async function updateMemberRole(req, res) {
  const userId = req.user?.sub;
  const { conversationId, userId: targetUserId } = req.params;
  const newRole = (req.body?.role || '').trim();

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!['owner', 'admin', 'member'].includes(newRole)) {
    return res.status(400).json({ message: 'Vai trò không hợp lệ' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const info = await getConversationAndMyRole(client, conversationId, userId);
    if (!info.exists) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!info.isGroup) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Not a group conversation' });
    }
    if (!info.isMember) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You are not a member of this group' });
    }

    const myRole = info.myRole;

    if (myRole !== 'owner' && myRole !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Chỉ chủ nhóm / quản trị viên mới được đổi vai trò' });
    }

    // Lấy info target
    const targetRes = await client.query(
      `
      SELECT user_id, role FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, targetUserId],
    );
    if (!targetRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Thành viên không tồn tại trong nhóm' });
    }

    const target = targetRes.rows[0];

    // Không cho đổi role của owner nếu mình không phải owner
    if (target.role === 'owner' && myRole !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Không thể đổi vai trò của chủ nhóm' });
    }

    // Nếu newRole = 'owner' -> chỉ cho phép chủ nhóm thao tác, và nên dùng API transfer-owner
    if (newRole === 'owner' && myRole !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Chỉ chủ nhóm mới có thể nhường quyền sở hữu' });
    }

    if (newRole === target.role) {
      await client.query('ROLLBACK');
      return res.status(200).json({ updated: false });
    }

    await client.query(
      `
      UPDATE conversation_members
      SET role = $3
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, targetUserId, newRole],
    );

    await client.query('COMMIT');
    return res.status(200).json({ updated: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('updateMemberRole error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

// PATCH /api/groups/:conversationId/members/:userId/can-send
// body: { canSend: boolean }
export async function updateMemberSendPermission(req, res) {
  const userId = req.user?.sub;
  const { conversationId, userId: targetUserId } = req.params;
  const canSend = !!req.body?.canSend;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const info = await getConversationAndMyRole(client, conversationId, userId);
    if (!info.exists) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!info.isGroup) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Not a group conversation' });
    }
    if (!info.isMember) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You are not a member of this group' });
    }

    const myRole = info.myRole;
    if (myRole !== 'owner' && myRole !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Chỉ chủ nhóm / quản trị viên mới được quản lý quyền gửi tin' });
    }

    const targetRes = await client.query(
      `
      SELECT user_id, role, is_muted
      FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, targetUserId],
    );
    if (!targetRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Thành viên không tồn tại trong nhóm' });
    }

    const target = targetRes.rows[0];
    if (target.role === 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Không thể tắt quyền gửi tin của chủ nhóm' });
    }

    const newMuted = !canSend;
    if (newMuted === target.is_muted) {
      await client.query('ROLLBACK');
      return res.status(200).json({ updated: false });
    }

    await client.query(
      `
      UPDATE conversation_members
      SET is_muted = $3
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, targetUserId, newMuted],
    );

    await client.query('COMMIT');
    return res.status(200).json({ updated: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('updateMemberSendPermission error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

// DELETE /api/groups/:conversationId/members/:userId
export async function removeMember(req, res) {
  const userId = req.user?.sub;
  const { conversationId, userId: targetUserId } = req.params;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const info = await getConversationAndMyRole(client, conversationId, userId);
    if (!info.exists) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!info.isGroup) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Not a group conversation' });
    }
    if (!info.isMember) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You are not a member of this group' });
    }

    const myRole = info.myRole;

    const targetRes = await client.query(
      `
      SELECT user_id, role
      FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, targetUserId],
    );
    if (!targetRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Thành viên không tồn tại trong nhóm' });
    }

    const target = targetRes.rows[0];

    if (target.role === 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Không thể xóa chủ nhóm' });
    }

    if (myRole === 'member') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Bạn không có quyền xóa thành viên' });
    }

    // Nếu muốn: không cho kick chính mình ở API này, nhưng FE đã chặn rồi
    await client.query(
      `
      DELETE FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, targetUserId],
    );

    await client.query('COMMIT');
    return res.status(200).json({ removed: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('removeMember error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

// POST /api/groups/:conversationId/transfer-owner
// body: { toUserId }
// src/controllers/groups.controller.js

// POST /api/groups/:conversationId/transfer-owner
// body: { targetUserId } hoặc { toUserId } (hỗ trợ cả 2 để tương thích FE cũ)
export async function transferGroupOwnership(req, res) {
  const userId = req.user?.sub;
  const { conversationId } = req.params;
  const targetUserId = req.body?.targetUserId ?? req.body?.toUserId;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (!targetUserId) {
    return res
      .status(400)
      .json({ message: 'Thiếu targetUserId / toUserId trong body' });
  }

  if (targetUserId === userId) {
    return res
      .status(400)
      .json({ message: 'Không thể nhường quyền sở hữu cho chính bạn' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // kiểm tra hội thoại, loại group, vai trò của mình
    const info = await getConversationAndMyRole(client, conversationId, userId);
    if (!info.exists) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!info.isGroup) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Not a group conversation' });
    }
    if (!info.isMember || info.myRole !== 'owner') {
      await client.query('ROLLBACK');
      return res
        .status(403)
        .json({ message: 'Chỉ chủ nhóm mới được nhường quyền sở hữu' });
    }

    // kiểm tra target có trong nhóm không
    const { rows: targetRows } = await client.query(
      `
      SELECT user_id, role, is_muted
      FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, targetUserId],
    );

    if (!targetRows.length) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ message: 'Thành viên không tồn tại trong nhóm' });
    }

    // hạ mình xuống admin (tuỳ ý bạn, có thể đổi thành 'member')
    await client.query(
      `
      UPDATE conversation_members
      SET role = 'admin'
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, userId],
    );

    // nâng target thành owner + bỏ mute (owner không thể bị mute)
    await client.query(
      `
      UPDATE conversation_members
      SET role = 'owner', is_muted = FALSE
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, targetUserId],
    );

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('transferGroupOwnership error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

export async function leaveGroup(req, res) {
  const userId = req.user?.sub;
  const { conversationId } = req.params;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Kiểm tra xem user có trong nhóm không + nhóm này có phải group không
    const { rows } = await client.query(
      `
      SELECT cm.role, c.type
      FROM conversation_members cm
      JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.conversation_id = $1 AND cm.user_id = $2
      `,
      [conversationId, userId],
    );

    if (!rows.length || rows[0].type !== 'group') {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Không tìm thấy nhóm' });
    }

    const myRole = rows[0].role;

    // Nếu là chủ nhóm thì không cho rời (theo đúng yêu cầu của bạn)
    if (myRole === 'owner') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'OWNER_CANT_LEAVE',
        message:
          'Chủ nhóm không thể rời nhóm. Hãy nhường quyền sở hữu cho người khác hoặc giải tán nhóm.',
      });
    }
    await client.query(
      `
      DELETE FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, userId],
    );

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('leaveGroup error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

// PATCH /api/groups/:conversationId
// body: { title?: string, description?: string }
export async function updateGroupInfo(req, res) {
  const userId = req.user?.sub;
  const { conversationId } = req.params;
  const { title, description } = req.body || {};

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const hasTitle =
    typeof title === 'string' && title.trim().length > 0;
  const hasDesc =
    typeof description === 'string'; // cho phép rỗng để xoá mô tả

  if (!hasTitle && !hasDesc) {
    return res
      .status(400)
      .json({ message: 'Không có dữ liệu để cập nhật' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const info = await getConversationAndMyRole(
      client,
      conversationId,
      userId,
    );
    if (!info.exists) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!info.isGroup) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Not a group conversation' });
    }
    if (!info.isMember) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'You are not a member of this group',
      });
    }

    // Chỉ cho chủ nhóm chỉnh sửa tên / mô tả
    if (info.myRole !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'Chỉ chủ nhóm mới được chỉnh sửa thông tin nhóm',
      });
    }

    // Cập nhật conversations.title nếu có title mới
    if (hasTitle) {
      await client.query(
        `UPDATE conversations
         SET title = $2
         WHERE id = $1`,
        [conversationId, title.trim()],
      );
    }

    // Upsert group_profiles để lưu name/description
    if (hasTitle || hasDesc) {
      const nameValue = hasTitle ? title.trim() : null;
      const descValue = hasDesc ? (description || '').trim() : null;

      await client.query(
        `
        INSERT INTO group_profiles (conversation_id, name, description)
        VALUES (
          $1,
          COALESCE($2, (SELECT title FROM conversations WHERE id = $1)),
          $3
        )
        ON CONFLICT (conversation_id) DO UPDATE
        SET
          name        = COALESCE(EXCLUDED.name, group_profiles.name),
          description = EXCLUDED.description
        `,
        [conversationId, nameValue, descValue],
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('updateGroupInfo error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

// PATCH /api/groups/:conversationId/avatar
export async function updateGroupAvatar(req, res) {
  const userId = req.user?.sub;
  const { conversationId } = req.params;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ message: 'Thiếu file avatar' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const info = await getConversationAndMyRole(
      client,
      conversationId,
      userId,
    );
    if (!info.exists) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Conversation not found' });
    }
    if (!info.isGroup) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Not a group conversation' });
    }
    if (!info.isMember) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'You are not a member of this group',
      });
    }
    if (info.myRole !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'Chỉ chủ nhóm mới được đổi ảnh nhóm',
      });
    }

    // Upload avatar mới lên Cloudinary
    const up = await uploadBufferToCloudinary(req.file.buffer, {
      folder: 'groups',
      resource_type: 'image',
    });

    const aRes = await client.query(
      `
      INSERT INTO assets (kind, url)
      VALUES ('image', $1)
      RETURNING id, url
      `,
      [up.secure_url],
    );
    const assetId = aRes.rows[0].id;
    const avatarUrl = aRes.rows[0].url;

    // Cập nhật conversations.avatar_asset_id
    await client.query(
      `
      UPDATE conversations
      SET avatar_asset_id = $2
      WHERE id = $1
      `,
      [conversationId, assetId],
    );

    // Upsert group_profiles để lưu avatar
    await client.query(
      `
      INSERT INTO group_profiles (conversation_id, name, avatar_asset_id)
      VALUES (
        $1,
        COALESCE((SELECT title FROM conversations WHERE id = $1), 'Nhóm'),
        $2
      )
      ON CONFLICT (conversation_id) DO UPDATE
      SET avatar_asset_id = EXCLUDED.avatar_asset_id
      `,
      [conversationId, assetId],
    );

    await client.query('COMMIT');
    return res.json({ ok: true, avatarUrl });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('updateGroupAvatar error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

