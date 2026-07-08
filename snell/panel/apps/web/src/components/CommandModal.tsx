import { Button, Modal, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import type { NodeDTO } from "@snell-panel/shared";
import { api } from "../api/client";
import { CommandBlock } from "./CommandBlock";

export function CommandModal({
  node,
  purpose,
  isOpen,
  onOpenChange,
}: {
  node: NodeDTO;
  purpose: "install" | "upgrade";
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const q = useQuery({
    queryKey: ["command", purpose, node.node_id],
    queryFn: () =>
      purpose === "install"
        ? api.installCommand(node.node_id)
        : api.upgradeCommand(node.node_id),
    enabled: isOpen,
    gcTime: 0,
    staleTime: 0,
  });

  const title = purpose === "install" ? "Install command" : "Upgrade to V6";

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-[680px]">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>
              {title} — {node.node_name}
            </Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            {q.isLoading && (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            )}
            {q.isError && (
              <p className="text-sm text-danger">{(q.error as Error).message}</p>
            )}
            {q.data && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted">
                  Run this on the server. The one-time token expires at{" "}
                  {new Date(q.data.expires_at * 1000).toLocaleString()}.
                </p>
                <CommandBlock code={q.data.command} />
                <p className="text-xs text-muted">Click the command to copy it.</p>
              </div>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" slot="close">
              Close
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
