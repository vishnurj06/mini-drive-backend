const mongoose = require("mongoose"); 

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected ✅"))
  .catch(err => console.log(err));

// 🔥 Email Transporter Setup (Use your own Gmail and an 'App Password')
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'bookofheroes1@gmail.com',      // Replace with your email
    pass: 'wcyjxrkwnespouqc'    // Replace with a Google App Password (not your real password)
  }
});

// 🔥 NEW: User Model
const User = mongoose.model("User", {
  username: String,
  email: { type: String, unique: true },
  password: String,
  otp: String,
  otpExpires: Date
});
  
// Multer setup
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// 🔥 NEW: Folder Schema
const Folder = mongoose.model("Folder", {
  name: String,
  owner: String,
  parentId: { type: String, default: null }, // null means it's on the main screen (root)
  createdAt: { type: Date, default: Date.now }
});

// 🔥 UPDATED: File Model (Notice the new 'size' property)
const File = mongoose.model("File", {
  fileName: String,
  url: String,
  public_id: String,
  size: Number, // <--- NEW
  owner: String,
  folderId: { type: String, default: null },
  sharedWith: [{ email: String, permission: String }],
  accessRequests: [{ email: String }],
  createdAt: { type: Date, default: Date.now }
});

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });
  const token = authHeader.split(" ")[1]; // 🔥 extract token

  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

// --- RENAME FOLDER ---
app.post("/rename-folder", verifyToken, async (req, res) => {
  try {
    const { folderId, newName } = req.body;
    await Folder.findOneAndUpdate(
        { _id: folderId, owner: req.user.email }, 
        { name: newName }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DELETE FOLDER (And its contents) ---
// --- DELETE FOLDER (And its contents) ---
app.post("/delete-folder", verifyToken, async (req, res) => {
  try {
    const { folderId } = req.body;
    
    // 1. Find all files inside this folder
    const files = await File.find({ folderId, owner: req.user.email });
    
    // 2. Delete those files from Cloudinary (UPDATED DELETION LOOP)
    for(let file of files) {
        // Dynamically figure out if Cloudinary stored it as an image, raw, or video
        let resourceType = "image";
        if (file.url.includes("/raw/upload/")) resourceType = "raw";
        if (file.url.includes("/video/upload/")) resourceType = "video";
        
        await cloudinary.uploader.destroy(file.public_id, { resource_type: resourceType });
    }

    // 3. Delete files from MongoDB
    await File.deleteMany({ folderId, owner: req.user.email });
    
    // 4. Delete the folder itself (and any immediate sub-folders)
    await Folder.deleteMany({ parentId: folderId, owner: req.user.email });
    await Folder.deleteOne({ _id: folderId, owner: req.user.email });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- FOLDER SYSTEM ROUTES ---

// 1. Create a new folder
app.post("/create-folder", verifyToken, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    const folder = await Folder.create({
      name,
      owner: req.user.email,
      parentId: parentId || null
    });
    res.json(folder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get contents of a specific folder (or root)
app.get("/my-drive", verifyToken, async (req, res) => {
  try {
    // If no folderId is passed, assume we are at the root (null)
    const currentFolderId = req.query.folderId || null;
    
    // Fetch folders and files that belong to this specific level
    const folders = await Folder.find({ owner: req.user.email, parentId: currentFolderId });
    const files = await File.find({ owner: req.user.email, folderId: currentFolderId });
    
    res.json({ folders, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1. Get a specific file via Shared Link
app.get("/file/:id", verifyToken, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ error: "File not found" });

    const isOwner = file.owner === req.user.email;
    const isAdmin = req.user.email === "admin@gmail.com";
    const sharedUser = file.sharedWith.find(u => u.email === req.user.email);

    if (isOwner || isAdmin || sharedUser) {
      // User has access
      return res.json({ access: true, file, permission: sharedUser ? sharedUser.permission : 'owner' });
    } else {
      // User does NOT have access, check if they already requested it
      const hasRequested = file.accessRequests.some(r => r.email === req.user.email);
      return res.json({ access: false, hasRequested, fileName: file.fileName, fileId: file._id });
    }
  } catch (err) {
    res.status(500).json({ error: "Invalid file link" });
  }
});

// 2. User requests access to a file
app.post("/request-access", verifyToken, async (req, res) => {
  try {
    const { fileId } = req.body;
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: "File not found" });

    // Prevent duplicates
    if (!file.accessRequests.some(r => r.email === req.user.email)) {
      file.accessRequests.push({ email: req.user.email });
      await file.save();
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Owner checks for pending requests on their files
app.get("/pending-requests", verifyToken, async (req, res) => {
  try {
    // Find files owned by the user that have at least one access request
    const files = await File.find({
      owner: req.user.email,
      "accessRequests.0": { $exists: true }
    });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔥 UPLOAD API (FIXED)
// 🔥 UPLOAD API (UPDATED FOR OFFICE FILES)
// 🔥 UPLOAD API (UPDATED TO FORCE FILE EXTENSIONS IN URL)
// 🔥 UPLOAD API (UPDATED WITH RECURSIVE FOLDER CREATION)
app.post("/upload", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // 1. Upload to Cloudinary
    const isRaw = !file.originalname.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|wav|m4a|ogg|aac|pdf)$/);
    const safeFileName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: isRaw ? "raw" : "auto",
          public_id: `minidrive_${Date.now()}_${safeFileName}`
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(file.buffer);
    });

    // 2. Resolve the Folder Path (The Magic Sauce)
    let targetFolderId = req.body.folderId === "null" || !req.body.folderId ? null : req.body.folderId;
    const relativePath = req.body.relativePath; // e.g., "Vacation/Italy/photo.jpg"

    if (relativePath && relativePath.includes('/')) {
        const pathParts = relativePath.split('/');
        pathParts.pop(); // Remove the file name at the end, leaving just the folder names
        
        let currentParentId = targetFolderId;
        
        // Loop through each folder name in the path
        for (const folderName of pathParts) {
            // Does this folder already exist at this level?
            let existingFolder = await Folder.findOne({
                name: folderName,
                parentId: currentParentId,
                owner: req.user.email
            });
            
            // If not, create it!
            if (!existingFolder) {
                existingFolder = await Folder.create({
                    name: folderName,
                    owner: req.user.email,
                    parentId: currentParentId
                });
            }
            // Move down the tree for the next iteration
            currentParentId = existingFolder._id;
        }
        // Set the final target folder for the file
        targetFolderId = currentParentId;
    }

    // 3. Save to Database
    await File.create({
      fileName: file.originalname,
      url: result.secure_url,
      public_id: result.public_id,
      owner: req.user.email,
      size: file.size,
      folderId: targetFolderId
    });

    res.json({ success: true, url: result.secure_url });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 DELETE API (FIXED ROUTE NAME)
// 🔥 DELETE API (UPDATED FOR EDITORS & ADMINS)
// --- DELETE FILE ---
app.post("/delete-file", verifyToken, async (req, res) => {
    try {
        const { public_id } = req.body;
        const file = await File.findOne({ public_id });
        if (!file) return res.status(404).json({ error: "File not found" });

        const isOwner = file.owner === req.user.email;
        const isAdmin = req.user.email === "admin@gmail.com";
        const isEditor = file.sharedWith.some(u => u.email === req.user.email && u.permission === "edit");

        if (!isOwner && !isAdmin && !isEditor) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        // 🔥 Dynamic Resource Type check based on the URL
        let resourceType = "image";
        if (file.url.includes("/raw/upload/")) resourceType = "raw";
        if (file.url.includes("/video/upload/")) resourceType = "video";

        await cloudinary.uploader.destroy(public_id, { resource_type: resourceType });
        await File.deleteOne({ _id: file._id });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/my-files", verifyToken, async (req, res) => {
  try {
    const files = await File.find({ owner: req.user.email });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/shared-files", verifyToken, async (req, res) => {
  try {
    const files = await File.find({ "sharedWith.email": req.user.email });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/share-file", verifyToken, async (req, res) => {
  try {
    // Note: Changed public_id to fileId to make it easier to work with MongoDB _id
    const { fileId, email, permission } = req.body; 
    
    const userExists = await User.findOne({ email });
    if (!userExists) {
      return res.status(404).json({ error: "User not found" });
    }

    // Allow sharing by either public_id (old way) or _id (new way)
    const query = mongoose.Types.ObjectId.isValid(fileId) ? { _id: fileId } : { public_id: fileId };
    const file = await File.findOne({ ...query, owner: req.user.email });
    
    if (!file) return res.status(403).json({ error: "File not found or unauthorized" });
    
    // Add or update permissions
    const alreadyShared = file.sharedWith.find(s => s.email === email);
    if (!alreadyShared) {
        file.sharedWith.push({ email, permission });
    } else {
        alreadyShared.permission = permission;
    }

    // 🔥 NEW: Remove the user from the accessRequests array once approved
    file.accessRequests = file.accessRequests.filter(r => r.email !== email);
    
    await file.save();
    res.json({ success: true, message: "Access granted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// --- SECURE AUTHENTICATION ---

// Signup (Now with strict Domain Validation & Username)
app.post("/signup", async (req, res) => {
  try {
    const { email, password, username } = req.body;
    
    // Valid Domain Regex
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: "Invalid email domain." });

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: "Email already exists" });

    // In a real app, hash the password here with bcrypt!
    await User.create({ email, password, username });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Login (Now returns username in token)
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, password });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    // Include username in the token payload
    const token = jwt.sign({ email: user.email, username: user.username }, process.env.JWT_SECRET, { expiresIn: "24h" });
    res.json({ token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- OTP & FORGOT PASSWORD ---

app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otpExpires = Date.now() + 10 * 60 * 1000; // Expires in 10 mins
    await user.save();

    // Send Email
    await transporter.sendMail({
      from: 'bookofheroes1@gmail.com',
      to: email,
      subject: 'Mini Drive Password Reset OTP',
      text: `Your password reset code is: ${otp}. It is valid for 10 minutes.`
    });

    res.json({ success: true });
  } catch (err) { 
    console.error("NODEMAILER ERROR:", err);
    // This will send the exact Gmail error message directly to your screen!
    res.status(500).json({ error: `Mail Error: ${err.message}` }); 
  }
});

app.post("/reset-password", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const user = await User.findOne({ email, otp, otpExpires: { $gt: Date.now() } });
    
    if (!user) return res.status(400).json({ error: "Invalid or expired OTP" });

    user.password = newPassword; // Update password
    user.otp = undefined; // Clear OTP
    user.otpExpires = undefined;
    await user.save();

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/all-files", verifyToken, async (req, res) => {
    if (req.user.email !== "admin@gmail.com") {
        return res.status(403).json({ error: "Access denied. Admins only." });
    }
    const allFiles = await File.find({});
    res.json(allFiles);
});

// --- REJECT ACCESS REQUEST ---
app.post("/reject-request", verifyToken, async (req, res) => {
  try {
    const { fileId, email } = req.body;
    const file = await File.findOne({ _id: fileId, owner: req.user.email });
    
    if (!file) return res.status(404).json({ error: "File not found" });

    // Filter out the requested email
    file.accessRequests = file.accessRequests.filter(r => r.email !== email);
    await file.save();
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});