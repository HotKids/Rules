import { useEffect, useState } from "react";
import { hasToken, UNAUTHORIZED_EVENT } from "./lib/auth";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";

export function App() {
  const [authed, setAuthed] = useState(hasToken());

  useEffect(() => {
    const onUnauth = () => setAuthed(false);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauth);
  }, []);

  return authed ? (
    <Dashboard onLogout={() => setAuthed(false)} />
  ) : (
    <Login onAuthed={() => setAuthed(true)} />
  );
}
