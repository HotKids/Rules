import { useState } from "react";
import { Button, Card, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { api } from "../api/client";
import { clearToken, setToken } from "../lib/auth";
import { Logo } from "../components/Logo";

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [storageMode, setStorageMode] = useState<"local" | "session" | "memory">("local");

  async function submit() {
    if (!value.trim()) return;
    setLoading(true);
    setError("");
    setToken(value.trim(), storageMode);
    try {
      await api.settings();
      onAuthed();
    } catch {
      clearToken();
      setError("Invalid access token.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-full items-center justify-center p-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-gradient-to-b from-accent/15 to-transparent" />

      <Card className="relative w-full max-w-[22rem] shadow-lg">
        <Card.Header className="items-center text-center">
          <Logo className="mx-auto mb-4 h-14 w-14" />
          <Card.Title>Snell Panel</Card.Title>
          <Card.Description>Sign in with your access token</Card.Description>
        </Card.Header>

        <div className="px-6 pb-1">
          <TextField value={value} onChange={setValue} type="password">
            <Label className="sr-only">Access Token</Label>
            <Input
              placeholder="Access token"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </TextField>
          <Select
            className="mt-4"
            selectedKey={storageMode}
            onSelectionChange={(k) => setStorageMode(String(k) as "local" | "session" | "memory")}
          >
            <Label>Keep signed in</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="local" textValue="On this device">On this device</ListBox.Item>
                <ListBox.Item id="session" textValue="Until tab closes">Until tab closes</ListBox.Item>
                <ListBox.Item id="memory" textValue="Clear on refresh">Clear on refresh</ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>

        <Card.Footer>
          <Button
            variant="primary"
            className="w-full"
            isDisabled={loading}
            onPress={submit}
          >
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </Card.Footer>
      </Card>
    </div>
  );
}
