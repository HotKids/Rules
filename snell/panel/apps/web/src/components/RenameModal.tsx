import { useState } from "react";
import { Button, Input, Label, Modal, TextField } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { NodeDTO, PatchNodeInput } from "@snell-panel/shared";
import { api } from "../api/client";

export function RenameModal({
  node,
  isOpen,
  onOpenChange,
}: {
  node: NodeDTO;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(node.node_name);
  const [ip, setIp] = useState(node.ip ?? "");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () => {
      const body: PatchNodeInput = {};
      if (name.trim() && name.trim() !== node.node_name) body.node_name = name.trim();
      if (ip.trim() && ip.trim() !== (node.ip ?? "")) body.ip = ip.trim();
      return api.patchNode(node.node_id, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nodes"] });
      onOpenChange(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit() {
    setError("");
    const changed =
      (name.trim() && name.trim() !== node.node_name) ||
      (ip.trim() && ip.trim() !== (node.ip ?? ""));
    if (!changed) return onOpenChange(false);
    mutation.mutate();
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-[440px]">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Edit node</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <TextField value={name} onChange={setName}>
                <Label>Node name</Label>
                <Input />
              </TextField>
              <TextField value={ip} onChange={setIp}>
                <Label>IP / Host</Label>
                <Input placeholder="changing this re-resolves geo" />
              </TextField>
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
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
