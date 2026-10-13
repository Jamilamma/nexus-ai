import React from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function LandingPage() {
  const { user, loading } = useAuth();

  // Logged-in users land straight in the product; the marketing page is only for visitors.
  if (!loading && user) return <Navigate to="/meetings" replace />;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-aurora-line shadow-glow flex items-center justify-center font-bold text-sm">
            N
          </div>
          <span className="font-semibold">NEXUS AI</span>
        </div>
        <div className="flex gap-3">
          <Link to="/login" className="btn-secondary text-sm">
            Log in
          </Link>
          <Link to="/register" className="btn-primary text-sm">
            Sign up
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
        <h1 className="text-4xl md:text-5xl font-semibold max-w-2xl leading-tight">
          Understand every conversation.
          <br />
          <span className="text-brand-400">In your language.</span>
        </h1>
        <p className="text-slate-400 max-w-xl mt-6 text-base">
          Real-time multilingual meeting intelligence with live transcription, translation, AI summaries, decisions,
          action items, and contextual Q&amp;A.
        </p>

        <div className="flex gap-4 mt-10">
          <Link to="/register" className="btn-primary px-6 py-3 text-base">
            Start a Meeting
          </Link>
          <Link to="/login" className="btn-secondary px-6 py-3 text-base">
            Join a Meeting
          </Link>
        </div>
      </main>

      <footer className="px-6 py-5 text-center text-xs text-slate-600">NEXUS AI — real-time meeting intelligence.</footer>
    </div>
  );
}
