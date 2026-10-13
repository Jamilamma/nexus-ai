import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import AppLayout from "./components/AppLayout";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import MeetingsPage from "./pages/MeetingsPage";
import MeetingPage from "./pages/MeetingPage";
import MeetingReportPage from "./pages/MeetingReportPage";
import SettingsPage from "./pages/SettingsPage";
import RecordingsPage from "./pages/RecordingsPage";
import RecordingDetailPage from "./pages/RecordingDetailPage";
import InterviewPage from "./pages/InterviewPage";
import RewritePage from "./pages/RewritePage";
import LiveMeetingPage from "./pages/LiveMeetingPage";

function Protected({ children }: { children: React.ReactElement }) {
  return (
    <ProtectedRoute>
      <AppLayout>{children}</AppLayout>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Meeting join links have no /app prefix so they stay short and shareable. */}
      <Route path="/meeting/:id" element={<Protected><MeetingPage /></Protected>} />

      {/* The dashboard was removed; old links and bookmarks land on Meetings. */}
      <Route path="/dashboard" element={<Navigate to="/meetings" replace />} />
      <Route path="/meetings" element={<Protected><MeetingsPage /></Protected>} />
      <Route path="/meetings/:id/report" element={<Protected><MeetingReportPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />

      {/* Primary product surface per the product-direction upgrade: Dashboard / Meetings / Settings.
          Everything below is demoted to "More Tools" in the nav but intentionally NOT deleted. */}
      <Route path="/recordings" element={<Protected><RecordingsPage /></Protected>} />
      <Route path="/recordings/:id" element={<Protected><RecordingDetailPage /></Protected>} />
      <Route path="/live-meeting" element={<Protected><LiveMeetingPage /></Protected>} />
      <Route path="/interview" element={<Protected><InterviewPage /></Protected>} />
      <Route path="/rewrite" element={<Protected><RewritePage /></Protected>} />
    </Routes>
  );
}
