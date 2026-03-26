const mongoose = require("mongoose"); 
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();

app.use(cors({
    origin: "*", 
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected ✅"))
  .catch(err => console.log(err));

// --- MODELS ---
const User = mongoose.model("User", {
  username: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: 'user' }, 
  otp: String,
  otpExpires: Date
});
  
const FolderSchema = new mongoose.Schema({
    name: { type: String, required: true },
    owner: { type: String, required: true },
    parentId: { type: String, default: null },
    sharedWith: [{
        email: String,
        permission: { type: String, default: 'view' }
    }],
    accessRequests: [{ email: String }], // 🔥 OPTION B: Folders can now receive requests
    createdAt: { type: Date, default: Date.now }
});
const Folder = mongoose.model('Folder', FolderSchema);

const File = mongoose.model("File", {
  fileName: String,
  url: String,
  public_id: String,
  size: Number,
  owner: String,
  folderId: { type: String, default: null },
  sharedWith: [{ email: String, permission: String }],
  accessRequests: [{ email: String }],
  createdAt: { type: Date, default: Date.now }
});

// --- CONFIG ---
const storage = multer.memoryStorage();
const upload = multer({ storage });

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// --- MIDDLEWARE ---
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });
  const token = authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

const verifyAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: "Access Denied: Admins Only" });
    }
};

// --- AUTHENTICATION ---
app.post("/signup", async (req, res) => {
  try {
    const { email, password, username } = req.body;
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: "Invalid email domain." });

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: "Email already exists" });

    await User.create({ email, password, username });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, password });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ email: user.email, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: "24h" });
    res.json({ token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User not found" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otpExpires = Date.now() + 10 * 60 * 1000;
    await user.save();
    
    const emailRes = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            service_id: process.env.EMAILJS_SERVICE_ID,
            template_id: process.env.EMAILJS_TEMPLATE_ID,
            user_id: process.env.EMAILJS_PUBLIC_KEY,
            accessToken: process.env.EMAILJS_PRIVATE_KEY,
            template_params: { to_email: email, otp: otp }
        })
    });

    if (!emailRes.ok) {
        const errorText = await emailRes.text();
        throw new Error(`EmailJS Error: ${errorText}`);
    }
    res.json({ success: true });
  } catch (err) { 
    console.error("EMAILJS ERROR:", err);
    res.status(500).json({ error: `Mail Error: ${err.message}` }); 
  }
});

app.post("/reset-password", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const user = await User.findOne({ email, otp, otpExpires: { $gt: Date.now() } });
    
    if (!user) return res.status(400).json({ error: "Invalid or expired OTP" });

    user.password = newPassword;
    user.otp = undefined;
    user.otpExpires = undefined;
    await user.save();

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ADMIN ROUTES ---
app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
    const userCount = await User.countDocuments();
    const fileCount = await File.countDocuments();
    res.json({ userCount, fileCount });
});

app.get("/admin/all-data", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const allFiles = await File.find({ owner: { $ne: req.user.email } });
        const allFolders = await Folder.find({ owner: { $ne: req.user.email } });
        const allUsers = await User.find({ email: { $ne: req.user.email } }, { password: 0 }); 
        res.json({ files: allFiles, folders: allFolders, users: allUsers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/all-files", verifyToken, verifyAdmin, async (req, res) => {
    const allFiles = await File.find({});
    res.json(allFiles);
});

// --- FOLDER & FILE MANAGEMENT ---
app.post("/create-folder", verifyToken, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    const folder = await Folder.create({ name, owner: req.user.email, parentId: parentId || null });
    res.json(folder);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/rename-folder", verifyToken, async (req, res) => {
  try {
    const { folderId, newName } = req.body;
    await Folder.findOneAndUpdate({ _id: folderId, owner: req.user.email }, { name: newName });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/delete-folder", verifyToken, async (req, res) => {
  try {
    const { folderId } = req.body;
    const folder = await Folder.findById(folderId);
    if (!folder) return res.status(404).json({ error: "Folder not found" });

    if (folder.owner !== req.user.email && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied" });
    }
    
    const files = await File.find({ folderId });
    for(let file of files) {
        let resourceType = "image";
        if (file.url.includes("/raw/upload/")) resourceType = "raw";
        if (file.url.includes("/video/upload/")) resourceType = "video";
        await cloudinary.uploader.destroy(file.public_id, { resource_type: resourceType });
    }

    await File.deleteMany({ folderId });
    await Folder.deleteMany({ parentId: folderId });
    await Folder.findByIdAndDelete(folderId);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/upload", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const isRaw = !file.originalname.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|wav|m4a|ogg|aac|pdf)$/);
    const safeFileName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: isRaw ? "raw" : "auto", public_id: `minidrive_${Date.now()}_${safeFileName}` },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(file.buffer);
    });

    let targetFolderId = req.body.folderId === "null" || !req.body.folderId ? null : req.body.folderId;
    const relativePath = req.body.relativePath;

    if (relativePath && relativePath.includes('/')) {
        const pathParts = relativePath.split('/');
        pathParts.pop(); 
        let currentParentId = targetFolderId;
        
        for (const folderName of pathParts) {
            let existingFolder = await Folder.findOne({ name: folderName, parentId: currentParentId, owner: req.user.email });
            if (!existingFolder) {
                existingFolder = await Folder.create({ name: folderName, owner: req.user.email, parentId: currentParentId });
            }
            currentParentId = existingFolder._id;
        }
        targetFolderId = currentParentId;
    }

    await File.create({
      fileName: file.originalname,
      url: result.secure_url,
      public_id: result.public_id,
      owner: req.user.email,
      size: file.size,
      folderId: targetFolderId
    });

    res.json({ success: true, url: result.secure_url });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/delete-file", verifyToken, async (req, res) => {
  try {
      const { fileId } = req.body; 
      const file = await File.findById(fileId);
      if (!file) return res.status(404).json({ error: "File not found" });

      if (file.owner !== req.user.email && req.user.role !== 'admin') {
          return res.status(403).json({ error: "Access Denied" });
      }

      if (file.public_id) {
          let resourceType = "image";
          if (file.url.includes("/raw/upload/")) resourceType = "raw";
          if (file.url.includes("/video/upload/")) resourceType = "video";
          await cloudinary.uploader.destroy(file.public_id, { resource_type: resourceType });
      }

      await File.findByIdAndDelete(fileId);
      res.json({ success: true });
  } catch (error) { res.status(500).json({ error: "Failed to delete file" }); }
});

app.get("/my-drive", verifyToken, async (req, res) => {
    try {
        const { folderId } = req.query;
        const email = req.user.email;
        
        if (!folderId) {
            const files = await File.find({ folderId: null, owner: email });
            const folders = await Folder.find({ parentId: null, owner: email });
            return res.json({ files, folders });
        } else {
            const parentFolder = await Folder.findById(folderId);
            if (!parentFolder) return res.status(404).json({ error: "Folder not found" });
            
            const isOwner = parentFolder.owner === email;
            const isShared = parentFolder.sharedWith.some(u => u.email === email);
            const isAdmin = req.user.role === 'admin';
            
            if (!isOwner && !isShared && !isAdmin) {
                return res.status(403).json({ error: "Access Denied: You do not have permission to view this folder." });
            }
            
            const files = await File.find({ folderId: folderId });
            const folders = await Folder.find({ parentId: folderId });
            return res.json({ files, folders });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/my-files", verifyToken, async (req, res) => {
  try {
    const files = await File.find({ owner: req.user.email });
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/shared-data", verifyToken, async (req, res) => {
    try {
        const email = req.user.email;
        const sharedFiles = await File.find({ "sharedWith.email": email });
        const sharedFolders = await Folder.find({ "sharedWith.email": email });
        res.json({ files: sharedFiles, folders: sharedFolders });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SHARING & ACCESS REQUESTS (OPTION B FULL SUITE) ---

app.get("/file/:id", verifyToken, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ error: "File not found" });

    const isOwner = file.owner === req.user.email;
    const isAdmin = req.user.role === 'admin';
    const sharedUser = file.sharedWith.find(u => u.email === req.user.email);

    if (isOwner || isAdmin || sharedUser) {
      return res.json({ access: true, file, permission: sharedUser ? sharedUser.permission : 'owner' });
    } else {
      const hasRequested = file.accessRequests.some(r => r.email === req.user.email);
      return res.json({ access: false, hasRequested, fileName: file.fileName, fileId: file._id });
    }
  } catch (err) { res.status(500).json({ error: "Invalid link" }); }
});

// 🔥 NEW: Folder Link Handler
app.get("/folder/:id", verifyToken, async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder) return res.status(404).json({ error: "Folder not found" });

    const isOwner = folder.owner === req.user.email;
    const isAdmin = req.user.role === 'admin';
    const sharedUser = folder.sharedWith.find(u => u.email === req.user.email);

    if (isOwner || isAdmin || sharedUser) {
      return res.json({ access: true, folder, permission: sharedUser ? sharedUser.permission : 'owner' });
    } else {
      const hasRequested = folder.accessRequests.some(r => r.email === req.user.email);
      return res.json({ access: false, hasRequested, fileName: folder.name, fileId: folder._id, isFolder: true });
    }
  } catch (err) { res.status(500).json({ error: "Invalid link" }); }
});

app.post("/request-access", verifyToken, async (req, res) => {
  try {
    const { fileId, folderId } = req.body;
    
    if (fileId) {
        const file = await File.findById(fileId);
        if (!file) return res.status(404).json({ error: "File not found" });
        if (!file.accessRequests.some(r => r.email === req.user.email)) {
          file.accessRequests.push({ email: req.user.email });
          await file.save();
        }
    } else if (folderId) {
        const folder = await Folder.findById(folderId);
        if (!folder) return res.status(404).json({ error: "Folder not found" });
        if (!folder.accessRequests.some(r => r.email === req.user.email)) {
          folder.accessRequests.push({ email: req.user.email });
          await folder.save();
        }
    }
    
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/pending-requests", verifyToken, async (req, res) => {
  try {
    const files = await File.find({ owner: req.user.email, "accessRequests.0": { $exists: true } });
    const folders = await Folder.find({ owner: req.user.email, "accessRequests.0": { $exists: true } });
    res.json({ files, folders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/share-file", verifyToken, async (req, res) => {
  try {
    const { fileId, email, permission } = req.body; 
    const userExists = await User.findOne({ email });
    if (!userExists) return res.status(404).json({ error: "User not found" });

    const query = mongoose.Types.ObjectId.isValid(fileId) ? { _id: fileId } : { public_id: fileId };
    const file = await File.findOne({ ...query, owner: req.user.email });
    if (!file) return res.status(403).json({ error: "File not found" });
    
    const alreadyShared = file.sharedWith.find(s => s.email === email);
    if (!alreadyShared) file.sharedWith.push({ email, permission });
    else alreadyShared.permission = permission;

    file.accessRequests = file.accessRequests.filter(r => r.email !== email);
    await file.save();
    
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/share-folder", verifyToken, async (req, res) => {
    try {
        const { folderId, email, permission } = req.body;
        const folder = await Folder.findById(folderId);
        
        if (!folder) return res.status(404).json({ error: "Folder not found" });
        if (folder.owner !== req.user.email) return res.status(403).json({ error: "Access Denied" });

        const alreadyShared = folder.sharedWith.find(u => u.email === email);
        if (alreadyShared) folder.sharedWith.permission = permission; 
        else folder.sharedWith.push({ email, permission }); 
        
        // 🔥 Remove from requests array once granted
        folder.accessRequests = folder.accessRequests.filter(r => r.email !== email);
        
        await folder.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/reject-request", verifyToken, async (req, res) => {
  try {
    const { fileId, folderId, email } = req.body;
    
    if (fileId) {
        const file = await File.findOne({ _id: fileId, owner: req.user.email });
        if (file) {
            file.accessRequests = file.accessRequests.filter(r => r.email !== email);
            await file.save();
        }
    } else if (folderId) {
        const folder = await Folder.findOne({ _id: folderId, owner: req.user.email });
        if (folder) {
            folder.accessRequests = folder.accessRequests.filter(r => r.email !== email);
            await folder.save();
        }
    }
    
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/", (req, res) => res.send("Backend is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});