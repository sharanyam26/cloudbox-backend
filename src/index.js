require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('./prismaClient');
const requireAuth = require('./middleware/auth');
const multer = require('multer');
const supabase = require('./supabaseClient');

const upload = multer({ storage: multer.memoryStorage() });
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ---------- AUTH ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email, and password are required' });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ message: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { name, email, passwordHash } });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'email and password are required' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) return res.status(401).json({ message: 'Invalid email or password' });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, name } = payload;

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { name, email, passwordHash: 'GOOGLE_OAUTH_NO_PASSWORD' },
      });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(401).json({ message: 'Google sign-in failed' });
  }
});
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({ id: user.id, name: user.name, email: user.email });
});

// ---------- FOLDERS ----------
app.post('/api/folders', requireAuth, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });

    const folder = await prisma.folder.create({
      data: { name, ownerId: req.userId, parentId: parentId || null },
    });
    res.json(folder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

app.get('/api/folders', requireAuth, async (req, res) => {
  const parentId = req.query.parentId || null;
  const folders = await prisma.folder.findMany({
    where: { ownerId: req.userId, parentId, trashed: false },
    orderBy: { name: 'asc' },
  });
  res.json(folders);
});

app.get('/api/folders/starred', requireAuth, async (req, res) => {
  const folders = await prisma.folder.findMany({
    where: { ownerId: req.userId, starred: true, trashed: false },
  });
  res.json(folders);
});

app.get('/api/folders/trash', requireAuth, async (req, res) => {
  const folders = await prisma.folder.findMany({
    where: { ownerId: req.userId, trashed: true },
  });
  res.json(folders);
});

app.patch('/api/folders/:id/rename', requireAuth, async (req, res) => {
  const folder = await prisma.folder.findUnique({ where: { id: req.params.id } });
  if (!folder || folder.ownerId !== req.userId) return res.status(404).json({ message: 'Folder not found' });

  const updated = await prisma.folder.update({
    where: { id: req.params.id },
    data: { name: req.body.name },
  });
  res.json(updated);
});

app.patch('/api/folders/:id/star', requireAuth, async (req, res) => {
  const folder = await prisma.folder.findUnique({ where: { id: req.params.id } });
  if (!folder || folder.ownerId !== req.userId) return res.status(404).json({ message: 'Folder not found' });

  const updated = await prisma.folder.update({
    where: { id: req.params.id },
    data: { starred: !folder.starred },
  });
  res.json(updated);
});

app.post('/api/folders/:id/trash', requireAuth, async (req, res) => {
  const folder = await prisma.folder.findUnique({ where: { id: req.params.id } });
  if (!folder || folder.ownerId !== req.userId) return res.status(404).json({ message: 'Folder not found' });

  await prisma.folder.update({ where: { id: req.params.id }, data: { trashed: true } });
  res.status(204).send();
});

app.post('/api/folders/:id/restore', requireAuth, async (req, res) => {
  const folder = await prisma.folder.findUnique({ where: { id: req.params.id } });
  if (!folder || folder.ownerId !== req.userId) return res.status(404).json({ message: 'Folder not found' });

  await prisma.folder.update({ where: { id: req.params.id }, data: { trashed: false } });
  res.status(204).send();
});

app.delete('/api/folders/:id', requireAuth, async (req, res) => {
  const folder = await prisma.folder.findUnique({ where: { id: req.params.id } });
  if (!folder || folder.ownerId !== req.userId) return res.status(404).json({ message: 'Folder not found' });

  await prisma.folder.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// ---------- FILES ----------
app.post('/api/files', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { folderId } = req.query;
    const storageKey = `${req.userId}/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const { error: uploadError } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .upload(storageKey, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) {
      console.error(uploadError);
      return res.status(500).json({ message: 'Upload to storage failed' });
    }

    const file = await prisma.file.create({
      data: {
        name: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storageKey,
        ownerId: req.userId,
        folderId: folderId || null,
      },
    });

    res.json(file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

app.get('/api/files', requireAuth, async (req, res) => {
  const folderId = req.query.folderId || null;
  const files = await prisma.file.findMany({
    where: { ownerId: req.userId, folderId, trashed: false },
    orderBy: { name: 'asc' },
  });
  res.json(files);
});

app.get('/api/files/starred', requireAuth, async (req, res) => {
  const files = await prisma.file.findMany({
    where: { ownerId: req.userId, starred: true, trashed: false },
  });
  res.json(files);
});

app.get('/api/files/trash', requireAuth, async (req, res) => {
  const files = await prisma.file.findMany({
    where: { ownerId: req.userId, trashed: true },
  });
  res.json(files);
});

app.get('/api/files/:id/download', requireAuth, async (req, res) => {
  const file = await prisma.file.findUnique({ where: { id: req.params.id } });
  if (!file) return res.status(404).json({ message: 'File not found' });

  const isOwner = file.ownerId === req.userId;
  const share = isOwner ? null : await prisma.share.findFirst({
    where: { resourceType: 'FILE', resourceId: file.id, sharedWithId: req.userId },
  });
  if (!isOwner && !share) return res.status(404).json({ message: 'File not found' });

  const { data, error } = await supabase.storage
    .from(process.env.SUPABASE_BUCKET)
    .download(file.storageKey);

  if (error) {
    console.error(error);
    return res.status(500).json({ message: 'Download failed' });
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  res.send(buffer);
});

app.patch('/api/files/:id/rename', requireAuth, async (req, res) => {
  const file = await prisma.file.findUnique({ where: { id: req.params.id } });
  if (!file || file.ownerId !== req.userId) return res.status(404).json({ message: 'File not found' });

  const updated = await prisma.file.update({ where: { id: req.params.id }, data: { name: req.body.name } });
  res.json(updated);
});

app.patch('/api/files/:id/star', requireAuth, async (req, res) => {
  const file = await prisma.file.findUnique({ where: { id: req.params.id } });
  if (!file || file.ownerId !== req.userId) return res.status(404).json({ message: 'File not found' });

  const updated = await prisma.file.update({ where: { id: req.params.id }, data: { starred: !file.starred } });
  res.json(updated);
});

app.post('/api/files/:id/trash', requireAuth, async (req, res) => {
  const file = await prisma.file.findUnique({ where: { id: req.params.id } });
  if (!file || file.ownerId !== req.userId) return res.status(404).json({ message: 'File not found' });

  await prisma.file.update({ where: { id: req.params.id }, data: { trashed: true } });
  res.status(204).send();
});

app.post('/api/files/:id/restore', requireAuth, async (req, res) => {
  const file = await prisma.file.findUnique({ where: { id: req.params.id } });
  if (!file || file.ownerId !== req.userId) return res.status(404).json({ message: 'File not found' });

  await prisma.file.update({ where: { id: req.params.id }, data: { trashed: false } });
  res.status(204).send();
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const file = await prisma.file.findUnique({ where: { id: req.params.id } });
  if (!file || file.ownerId !== req.userId) return res.status(404).json({ message: 'File not found' });

  await supabase.storage.from(process.env.SUPABASE_BUCKET).remove([file.storageKey]);
  await prisma.file.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// ---------- SHARING ----------
app.post('/api/shares', requireAuth, async (req, res) => {
  try {
    const { resourceType, resourceId, shareWithEmail, role } = req.body;
    if (!resourceType || !resourceId || !shareWithEmail || !role) {
      return res.status(400).json({ message: 'resourceType, resourceId, shareWithEmail, and role are required' });
    }

    const resource = resourceType === 'FILE'
      ? await prisma.file.findUnique({ where: { id: resourceId } })
      : await prisma.folder.findUnique({ where: { id: resourceId } });

    if (!resource || resource.ownerId !== req.userId) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    const targetUser = await prisma.user.findUnique({ where: { email: shareWithEmail.toLowerCase() } });
    if (!targetUser) return res.status(404).json({ message: 'No user found with that email' });
    if (targetUser.id === req.userId) return res.status(400).json({ message: 'You cannot share with yourself' });

    const share = await prisma.share.create({
      data: { resourceType, resourceId, sharedById: req.userId, sharedWithId: targetUser.id, role },
    });

    res.json(share);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Something went wrong' });
  }
});

app.get('/api/shares/with-me', requireAuth, async (req, res) => {
  const shares = await prisma.share.findMany({
    where: { sharedWithId: req.userId },
    include: { sharedBy: { select: { email: true } } },
  });

  const enriched = await Promise.all(shares.map(async (s) => {
    const resource = s.resourceType === 'FILE'
      ? await prisma.file.findUnique({ where: { id: s.resourceId } })
      : await prisma.folder.findUnique({ where: { id: s.resourceId } });
    return { ...s, resource };
  }));

  res.json(enriched.filter((s) => s.resource));
});

app.delete('/api/shares/:id', requireAuth, async (req, res) => {
  const share = await prisma.share.findUnique({ where: { id: req.params.id } });
  if (!share || share.sharedById !== req.userId) return res.status(404).json({ message: 'Share not found' });

  await prisma.share.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// ---------- SEARCH ----------
app.get('/api/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ folders: [], files: [] });

  const [folders, files] = await Promise.all([
    prisma.folder.findMany({
      where: { ownerId: req.userId, trashed: false, name: { contains: q, mode: 'insensitive' } },
    }),
    prisma.file.findMany({
      where: { ownerId: req.userId, trashed: false, name: { contains: q, mode: 'insensitive' } },
    }),
  ]);

  res.json({ folders, files });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));