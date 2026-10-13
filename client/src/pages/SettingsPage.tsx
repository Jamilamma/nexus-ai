import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { SUPPORTED_MEETING_LANGUAGES } from "../types";

const LANGUAGE_KEY = "nexus_default_language";

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const [defaultLanguage, setDefaultLanguage] = useState(localStorage.getItem(LANGUAGE_KEY) || "English");
  const [saved, setSaved] = useState(false);

  function save() {
    localStorage.setItem(LANGUAGE_KEY, defaultLanguage);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="max-w-lg space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">Your account and meeting preferences.</p>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="font-medium mb-2">Account</h2>
        <div className="text-sm">
          <div className="text-slate-500">Name</div>
          <div className="text-slate-200">{user?.name}</div>
        </div>
        <div className="text-sm">
          <div className="text-slate-500">Email</div>
          <div className="text-slate-200">{user?.email}</div>
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <h2 className="font-medium">Meeting preferences</h2>
        <div>
          <label className="label">Default language for new meetings</label>
          <select value={defaultLanguage} onChange={(e) => setDefaultLanguage(e.target.value)} className="input">
            {SUPPORTED_MEETING_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <button onClick={save} className="btn-primary">
          {saved ? "Saved!" : "Save"}
        </button>
      </div>

      <button onClick={logout} className="text-sm text-red-400 hover:underline">
        Log out
      </button>
    </div>
  );
}
