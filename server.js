const mongoose = require("mongoose"); 

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;



const app = express();
// Give the backend an all-access pass to talk to your Vercel frontend
app.use(cors({
    origin: "*", // The asterisk means "Allow any URL to connect"
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected ✅"))
  .catch(err => console.log(err));


// 🔥 NEW: User Model
const User = mongoose.model("User", {
  username: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: 'user' }, // 'user' or 'admin'
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
const FolderSchema = new mongoose.Schema({
    name: { type: String, required: true },
    owner: { type: String, required: true },
    parentId: { type: String, default: null },
    // Folder sharing array
    sharedWith: [{
        email: String,
        permission: { type: String, default: 'view' }
    }],
    createdAt: { type: Date, default: Date.now }
});

// 🔥 THE MISSING LINE: This is what actually creates the "Folder" variable!
const Folder = mongoose.model('Folder', FolderSchema);

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

const verifyAdmin = (req, res, next) => {
    // We assume verifyToken has already run and attached user to req
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: "Access Denied: Admins Only" });
    }
};

// Example Admin Route
app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
    const userCount = await User.countDocuments();
    const fileCount = await File.countDocuments();
    res.json({ userCount, fileCount });
});

// Get ALL files and ALL users (Admin Only)
app.get("/admin/all-data", verifyToken, verifyAdmin, async (req, res) => {
    try {
        // 🔥 FIX: Find files where the owner is NOT EQUAL ($ne) to the admin's email
        const allFiles = await File.find({ owner: { $ne: req.user.email } });
        
        // Optional: Do the same for users so you don't see yourself in a user list!
        const allUsers = await User.find({ email: { $ne: req.user.email } }, { password: 0 }); 
        
        res.json({ files: allFiles, users: allUsers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
    
    // 1. Find the folder first so we can check who actually owns it
    const folder = await Folder.findById(folderId);
    if (!folder) {
        return res.status(404).json({ error: "Folder not found" });
    }

    // 2. 🔥 THE MASTER KEY CHECK: Are you the owner OR an admin?
    if (folder.owner !== req.user.email && req.user.role !== 'admin') {
        return res.status(403).json({ error: "Access Denied: You do not own this folder." });
    }
    
    // 3. Find all files inside this folder (We removed the owner check here because you are already authorized!)
    const files = await File.find({ folderId });
    
    // 4. Delete those files from Cloudinary 
    for(let file of files) {
        let resourceType = "image";
        if (file.url.includes("/raw/upload/")) resourceType = "raw";
        if (file.url.includes("/video/upload/")) resourceType = "video";
        
        await cloudinary.uploader.destroy(file.public_id, { resource_type: resourceType });
    }

    // 5. Delete files from MongoDB
    await File.deleteMany({ folderId });
    
    // 6. Delete the folder itself (and any immediate sub-folders)
    await Folder.deleteMany({ parentId: folderId });
    await Folder.findByIdAndDelete(folderId);

    res.json({ success: true });
  } catch (err) {
    console.error("Folder delete error:", err);
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
// 🔥 THE UPGRADE: Smart Folder Navigation
app.get("/my-drive", verifyToken, async (req, res) => {
    try {
        const { folderId } = req.query;
        const email = req.user.email;
        
        if (!folderId) {
            // SCENARIO 1: Root Directory - Only show stuff I own
            const files = await File.find({ folderId: null, owner: email });
            const folders = await Folder.find({ parentId: null, owner: email });
            return res.json({ files, folders });
        } else {
            // SCENARIO 2: Inside a Folder - Check permissions!
            const parentFolder = await Folder.findById(folderId);
            if (!parentFolder) return res.status(404).json({ error: "Folder not found" });
            
            // Do I own it? Is it shared with me? Am I an admin?
            const isOwner = parentFolder.owner === email;
            const isShared = parentFolder.sharedWith.some(u => u.email === email);
            const isAdmin = req.user.role === 'admin';
            
            if (!isOwner && !isShared && !isAdmin) {
                return res.status(403).json({ error: "Access Denied: You do not have permission to view this folder." });
            }
            
            // If they pass the security check, show them the contents!
            const files = await File.find({ folderId: folderId });
            const folders = await Folder.find({ parentId: folderId });
            return res.json({ files, folders });
        }
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
      const { fileId } = req.body; // This now perfectly matches what the frontend is sending
      
      const file = await File.findById(fileId);
      if (!file) {
          return res.status(404).json({ error: "File not found in database" });
      }

      // Master Key Check: Owner OR Admin
      if (file.owner !== req.user.email && req.user.role !== 'admin') {
          return res.status(403).json({ error: "Access Denied: You do not own this file." });
      }

      // 🔥 THE FIX: Use public_id (from your MongoDB) and dynamically check resource type
      if (file.public_id) {
          let resourceType = "image";
          if (file.url.includes("/raw/upload/")) resourceType = "raw";
          if (file.url.includes("/video/upload/")) resourceType = "video";
          
          await cloudinary.uploader.destroy(file.public_id, { resource_type: resourceType });
      }

      // Delete from MongoDB
      await File.findByIdAndDelete(fileId);

      res.json({ success: true, message: "File deleted successfully" });
  } catch (error) {
      console.error("Delete error:", error);
      res.status(500).json({ error: "Failed to delete file" });
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

// 🔥 THE UPGRADE: Fetch both shared files AND shared folders
app.get("/shared-data", verifyToken, async (req, res) => {
    try {
        const email = req.user.email;
        const sharedFiles = await File.find({ "sharedWith.email": email });
        const sharedFolders = await Folder.find({ "sharedWith.email": email });
        
        res.json({ files: sharedFiles, folders: sharedFolders });
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

// 🔥 NEW ROUTE: Share a Folder
app.post("/share-folder", verifyToken, async (req, res) => {
    try {
        const { folderId, email, permission } = req.body;
        const folder = await Folder.findById(folderId);
        
        if (!folder) return res.status(404).json({ error: "Folder not found" });
        if (folder.owner !== req.user.email) return res.status(403).json({ error: "Only the owner can share this folder" });

        const alreadyShared = folder.sharedWith.find(u => u.email === email);
        if (alreadyShared) {
            alreadyShared.permission = permission; // Update permission if already shared
        } else {
            folder.sharedWith.push({ email, permission }); // Add new user
        }
        
        await folder.save();
        res.json({ success: true, message: "Folder shared successfully!" });
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
    // Inside your app.post("/login", ...) route:

// Change this line:
const token = jwt.sign({ email: user.email, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: "24h" });
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
    
    // Send Email via EmailJS API
    const emailRes = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            service_id: process.env.EMAILJS_SERVICE_ID,
            template_id: process.env.EMAILJS_TEMPLATE_ID,
            user_id: process.env.EMAILJS_PUBLIC_KEY,
            accessToken: process.env.EMAILJS_PRIVATE_KEY,
            template_params: {
                to_email: email,    // The email the user typed in
                otp: otp            // The 6-digit code
            }
        })
    });

    if (!emailRes.ok) {
        const errorText = await emailRes.text();
        throw new Error(`EmailJS Error: ${errorText}`);
    }
    res.json({ success: true });
  } catch (err) { 
    console.error("EMAILJS ERROR:", err);
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