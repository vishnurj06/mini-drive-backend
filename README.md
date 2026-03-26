\# ⚙️ Mini Drive - Backend API



!\[NodeJS](https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge\&logo=node.js\&logoColor=white)

!\[Express.js](https://img.shields.io/badge/express.js-%23404d59.svg?style=for-the-badge\&logo=express\&logoColor=%2361DAFB)

!\[MongoDB](https://img.shields.io/badge/MongoDB-%234ea94b.svg?style=for-the-badge\&logo=mongodb\&logoColor=white)

!\[Cloudinary](https://img.shields.io/badge/Cloudinary-3448C5?style=for-the-badge\&logo=Cloudinary\&logoColor=white)

!\[Render](https://img.shields.io/badge/Render-%46E3B7.svg?style=for-the-badge\&logo=render\&logoColor=white)



This is the RESTful API that powers the \*\*Mini Drive\*\* cloud storage application. It handles secure file uploads, hierarchical database mapping, and complex multi-user permission logic.



\*\*Frontend Repository:\*\* \[[Link to frontend GitHub repo](https://github.com/vishnurj06/mini-drive-frontend)]



\## 🏗️ Architecture \& Tech Stack

\* \*\*Server:\*\* Node.js with Express.js.

\* \*\*Database:\*\* MongoDB (Mongoose ODM) for storing User, File, and Folder schemas.

\* \*\*File Storage:\*\* Cloudinary integration for secure, scalable cloud blob storage.

\* \*\*Authentication:\*\* JSON Web Tokens (JWT) and Bcrypt for secure session management.

\* \*\*Mail Service:\*\* EmailJS for delivering 6-digit OTPs for password recovery.



\## 🔐 Core Security Features

\* \*\*Role-Based Access Control (RBAC):\*\* Middleware protecting `/admin` routes.

\* \*\*Ownership Validation:\*\* Ensure users can only delete or rename data they explicitly own.

\* \*\*Recursive Deletion:\*\* If a parent folder is deleted, the backend automatically scrubs all nested child folders and files from both MongoDB and Cloudinary.

\* \*\*Unified Access Engine:\*\* A single, dynamic engine handling view/edit permission requests for both distinct files and entire folder trees.



\## 🛠️ Local Setup

To run this API locally, you will need a `.env` file in the root directory with the following variables:

```env

PORT=3000

MONGO\\\_URI=your\\\_mongodb\\\_connection\\\_string

JWT\\\_SECRET=your\\\_jwt\\\_secret

CLOUD\\\_NAME=your\\\_cloudinary\\\_name

API\\\_KEY=your\\\_cloudinary\\\_api\\\_key

API\\\_SECRET=your\\\_cloudinary\\\_secret

EMAILJS\\\_SERVICE\\\_ID=your\\\_emailjs\\\_id

EMAILJS\\\_TEMPLATE\\\_ID=your\\\_emailjs\\\_template

EMAILJS\\\_PUBLIC\\\_KEY=your\\\_emailjs\\\_public

EMAILJS\\\_PRIVATE\\\_KEY=your\\\_emailjs\\\_private


