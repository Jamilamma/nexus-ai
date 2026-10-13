# NEXUS AI — AI-Powered Video Meeting Platform

**Smarter meetings. Clearer conversations. Actionable insights.**

NEXUS AI is an AI-powered video meeting platform that combines real-time video conferencing, speech-to-text transcription, speaker identification, meeting summaries, and an interactive AI meeting assistant in one web application.

The project explores how artificial intelligence can make online meetings more accessible, understandable, and productive.

## ✨ Features

* **Real-Time Video Meetings** — Join online meetings with live audio and video.
* **Live Speech Transcription** — Convert spoken conversations into text using Whisper-based speech recognition.
* **Speaker Identification** — Associate transcript segments with meeting participants where supported by the meeting audio pipeline.
* **Multilingual Speech Processing** — Explore transcription for supported languages, including English, Tamil, Hindi, and Arabic.
* **AI Meeting Summaries** — Generate concise summaries of discussions and key information.
* **Ask NEXUS** — Ask questions about available meeting transcripts and context.
* **Meeting History** — Store and revisit meeting information using the application's database.
* **Full-Stack Architecture** — Separate frontend, backend, meeting infrastructure, and speech-processing service.

*Feature availability and accuracy depend on configuration, provider access, deployment resources, and implementation status.*

## 🛠️ Technology Stack

| Component               | Technologies                          |
| ----------------------- | ------------------------------------- |
| Frontend                | React, TypeScript, Vite               |
| Backend                 | Node.js, Express.js, TypeScript       |
| Real-Time Communication | Socket.IO                             |
| Video Conferencing      | LiveKit                               |
| Database                | MongoDB, Mongoose                     |
| Speech Recognition      | Python, faster-whisper, Whisper       |
| AI Capabilities         | Configured AI language model provider |
| Development Tools       | Git, GitHub, VS Code                  |

## 🏗️ Architecture

```text
User / Browser
      |
      v
React + TypeScript Frontend
      |
      +------ LiveKit ------> Audio / Video Meetings
      |
      v
Node.js + Express Backend
      |
      +------ Socket.IO ----> Real-Time Events
      |
      +------ MongoDB ------> Meeting Data
      |
      +------ Whisper ------> Speech Transcription
      |
      +------ AI Provider --> Summaries / Meeting Q&A
```

The Whisper service runs separately from the main Node.js backend. The backend coordinates application requests and speech-processing operations.

## 📁 Project Structure

```text
nexus-ai/
├── client/          # React + TypeScript frontend
├── server/          # Express backend and APIs
├── stt-service/     # Python speech-to-text service
├── .gitignore
└── README.md
```

*Folder contents may evolve as development continues.*

## 🚀 Getting Started

### Prerequisites

Install the following before running the project:

* Node.js and npm
* Python 3
* MongoDB database or MongoDB Atlas
* LiveKit account and project credentials
* API credentials for the configured AI and speech services

### 1. Clone the repository

```bash
git clone https://github.com/YOUR-USERNAME/nexus-ai.git
cd nexus-ai
```

Replace `YOUR-USERNAME` with your GitHub username.

### 2. Install frontend dependencies

```bash
cd client
npm install
```

Configure the frontend environment variables using the names expected by the existing application. Start the frontend using the script defined in `client/package.json`, commonly:

```bash
npm run dev
```

### 3. Configure the backend

Open another terminal:

```bash
cd server
npm install
```

Create a local `.env` file based on `server/.env.example`. Fill in the required values locally.

Typical configuration categories include:

* MongoDB connection URI
* LiveKit URL, API key, and API secret
* AI provider API key and model
* Speech transcription provider settings
* Whisper service URL
* Application port and authentication settings

Use the exact variable names expected by the existing code. Never commit real credentials.

Start the backend using the script defined in `server/package.json`.

### 4. Configure the Whisper service

Open another terminal:

```bash
cd stt-service
```

Create and activate a Python virtual environment:

**Windows PowerShell**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

**macOS / Linux**

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Install dependencies using the service's existing dependency file, such as `requirements.txt`, if present. Follow the startup instructions provided by the project.

The Whisper model may require a substantial initial download and significant CPU, memory, or GPU resources.

### 5. Run and verify

Start the frontend, backend, and speech service in separate terminals as required by the project.

Verify that:

1. The application opens successfully.
2. Users can join a meeting.
3. Audio and video work between participants.
4. The backend can reach the speech service.
5. Speech appears in the transcript.
6. Speaker attribution is checked with multiple participants.
7. Summary and Ask NEXUS features work with the available meeting context.

Actual commands and configuration may differ depending on the current project scripts.

## 🌐 Deployment

NEXUS AI is intended to be deployable as a web application.

A deployment may use:

* **Frontend:** Vercel or another compatible static frontend host.
* **Backend:** A Node.js host supporting persistent WebSocket connections.
* **Database:** MongoDB Atlas.
* **Video Infrastructure:** LiveKit Cloud.
* **Speech Service:** A reachable Python service with sufficient compute resources.

The frontend, backend, and speech service must be configured to communicate through the correct deployed URLs.

**Important:** Free hosting does not guarantee reliable, continuous Whisper transcription. CPU and memory limits, service sleep, model download time, and network latency can affect performance. A local Whisper URL such as `http://127.0.0.1:9000` must be replaced with an appropriate private service URL in the deployed environment.

## 🔐 Security

* Never commit `.env` files, API keys, passwords, or database credentials.
* Keep `.env.example` limited to placeholder values.
* Restrict access to the Whisper service and backend endpoints.
* Protect meeting transcripts and recordings as private user data.
* Rotate any credentials accidentally exposed in screenshots or public repositories.
* Configure authentication, CORS, and access permissions before public deployment.

## 🗺️ Future Improvements

* Improve live transcription accuracy and latency.
* Strengthen multilingual and code-switched speech recognition.
* Improve speaker attribution in multi-participant meetings.
* Enhance summary quality and context-aware meeting questions.
* Expand automated testing and deployment reliability.
* Improve privacy controls and error handling.

## 👩‍💻 Contributing

Suggestions, bug reports, and contributions are welcome. Please describe the issue, steps to reproduce it, and the expected behavior when submitting feedback.

## 📄 License

No license has been specified yet. Add a `LICENSE` file before granting others permission to reuse, modify, or distribute this project.

---

**NEXUS AI** — Exploring the future of intelligent meetings.
