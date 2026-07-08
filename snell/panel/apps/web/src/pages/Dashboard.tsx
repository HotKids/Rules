import { useState } from "react";
import { Button } from "@heroui/react";
import { clearToken } from "../lib/auth";
import { useNodes } from "../api/hooks";
import { NodesTable } from "../components/NodesTable";
import { AddNodeModal } from "../components/AddNodeModal";
import { SubscriptionModal } from "../components/SubscriptionModal";
import { ThemeToggle } from "../components/ThemeToggle";
import { Logo } from "../components/Logo";

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-5" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-5" aria-hidden="true">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61" />
      <path d="m2 2 20 20" />
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-black/5 bg-background-secondary px-5 py-4 dark:border-white/10">
      <p className="text-xs tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [privacy, setPrivacy] = useState(
    () => localStorage.getItem("snell_privacy") === "1",
  );

  function togglePrivacy() {
    setPrivacy((p) => {
      const v = !p;
      localStorage.setItem("snell_privacy", v ? "1" : "0");
      return v;
    });
  }

  const { data } = useNodes();
  const list = data ?? [];
  const total = list.length;
  const active = list.filter((n) => n.status === "active").length;
  const hidden = list.filter((n) => !n.enabled).length;

  return (
    <div className="relative min-h-full">
      {/* subtle brand glow */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-accent/10 to-transparent" />

      <div className="relative mx-auto flex max-w-6xl flex-col gap-7 p-4 sm:p-6">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo className="h-9 w-9" />
            <div className="leading-tight">
              <h1 className="text-lg font-semibold">Snell Panel</h1>
              <p className="text-xs text-muted">Node &amp; subscription manager</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              aria-label={privacy ? "Show IP and port" : "Hide IP and port"}
              className="px-2"
              onPress={togglePrivacy}
            >
              {privacy ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
            <ThemeToggle />
            <Button
              variant="tertiary"
              onPress={() => {
                clearToken();
                onLogout();
              }}
            >
              Logout
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          <Stat label="Total" value={total} />
          <Stat label="Active" value={active} />
          <Stat label="Hidden" value={hidden} />
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium">Nodes</h2>
            <div className="flex gap-2">
              <Button variant="secondary" onPress={() => setSubOpen(true)}>
                Subscription
              </Button>
              <Button variant="primary" onPress={() => setAddOpen(true)}>
                Add Node
              </Button>
            </div>
          </div>
          <NodesTable privacy={privacy} />
        </div>
      </div>

      <AddNodeModal isOpen={addOpen} onOpenChange={setAddOpen} />
      <SubscriptionModal isOpen={subOpen} onOpenChange={setSubOpen} />
    </div>
  );
}
