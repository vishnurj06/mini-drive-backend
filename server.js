const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const users = [];

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected ✅"))
  .catch(err => console.log(err));
  
// Multer setup
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

const File = mongoose.model("File", {
  fileName: String,
  url: String,
  public_id: String,
  owner: String,
  sharedWith: [
    {
      email: String,
      permission: String
    }
  ]
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

// 🔥 UPLOAD API (FIXED)
app.post("/upload", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Detect file type
    const isPDF = file.mimetype === "application/pdf";

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: isPDF ? "raw" : "auto", // 🔥 FIX
          access_mode: "public" // 🔥 IMPORTANT FIX
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(file.buffer);
    });

    // 🔥 SAVE TO DATABASE
    await File.create({
      fileName: file.originalname,
      url: result.secure_url,
      public_id: result.public_id,
      owner: req.user.email
    });

    res.json({
      url: result.secure_url,
      public_id: result.public_id,
      resource_type: result.resource_type
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 DELETE API (FIXED ROUTE NAME)
app.post("/delete-file", verifyToken, async (req, res) => {
  try {
    const { public_id, resource_type } = req.body;

    await cloudinary.uploader.destroy(public_id, {
      resource_type: resource_type || "raw"
    });

    // 🔥 DELETE FROM DATABASE
    await File.deleteOne({ public_id });

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
    const { public_id, email, permission } = req.body;
    
    const file = await File.findOne({ public_id, owner: req.user.email });
    if (!file) return res.status(404).json({ error: "File not found or unauthorized" });
    
    const alreadyShared = file.sharedWith.find(s => s.email === email);
    if (!alreadyShared) {
        file.sharedWith.push({ email, permission });
        await file.save();
    } else {
        alreadyShared.permission = permission;
        await file.save();
    }
    
    res.json({ success: true, message: "File shared successfully" });
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

app.post("/signup", async (req, res) => {
  const { email, password } = req.body;

  const hashedPassword = await bcrypt.hash(password, 10);

  users.push({ email, password: hashedPassword });

  res.json({ message: "User created successfully" });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: "User not found" });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(400).json({ error: "Wrong password" });

  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1h" });

  res.json({ token });
});