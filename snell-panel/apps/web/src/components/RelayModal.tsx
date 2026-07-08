import { useState } from "react";
import { Button, Input, Label, Modal, TextField } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { NodeDTO } from "@snell-panel/shared";
import { api } from "../api/client";

export function RelayModal({
  origin,
  isOpen,
  onOpenChange,
}: {
  origin: NodeDTO;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(`${origin.node_name} (relay)`);
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api.relayNode(origin.node_id, {
        node_name: name.trim(),
        ip: ip.trim(),
        port: Number(port),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nodes"] });
      onOpenChange(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit() {
    setError("");
    if (!name.trim() || !ip.trim() || !port.trim()) {
      return setError("Name, IP and port are required.");
    }
    if (!/^\d+$/.test(port.trim())) return setError("Port must be a number.");
    mutation.mutate();
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-[460px]">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Add relay</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted">
                Creates a new active node that reuses{" "}
                <span className="font-medium">{origin.node_name}</span>’s PSK and
                version, but points at a different IP/port (the relay front).
              </p>
              <TextField value={name} onChange={setName}>
                <Label>Relay node name</Label>
                <Input placeholder="e.g. Tokyo via HK" />
              </TextField>
              <div className="flex gap-3">
                <TextField value={ip} onChange={setIp} className="flex-1">
                  <Label>Relay IP / Host</Label>
                  <Input placeholder="relay address" />
                </TextField>
                <TextField value={port} onChange={setPort} className="w-28">
                  <Label>Port</Label>
                  <Input placeholder="port" inputMode="numeric" />
                </TextField>
              </div>
              {error && <p className="text-sm text-danger">{error}</p>}
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" slot="close">
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={submit}
              isDisabled={mutation.isPending}
            >
              {mutation.isPending ? "Creating…" : "Create relay"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
