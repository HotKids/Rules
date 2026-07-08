import { useState } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Switch,
  TextField,
} from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_SS2022_METHOD,
  SS2022_METHODS,
  type CreateNodeInput,
  type NodeProtocol,
  type SnellVersion,
  type SS2022Method,
} from "@snell-panel/shared";
import { api } from "../api/client";

export function AddNodeModal({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [protocol, setProtocol] = useState<NodeProtocol>("snell");
  const [version, setVersion] = useState<SnellVersion>("6");
  const [method, setMethod] = useState<SS2022Method>(DEFAULT_SS2022_METHOD);
  const [name, setName] = useState("");
  const [prefill, setPrefill] = useState(false);
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("");
  const [tfo, setTfo] = useState(true);
  const [error, setError] = useState("");

  function reset() {
    setProtocol("snell");
    setVersion("6");
    setMethod(DEFAULT_SS2022_METHOD);
    setName("");
    setPrefill(false);
    setIp("");
    setPort("");
    setTfo(true);
    setError("");
  }

  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateNodeInput = { protocol, node_name: name.trim(), tfo };
      if (protocol === "snell") body.version = version;
      if (protocol === "ss2022") {
        body.version = "2022";
        body.method = method;
      }
      if (prefill && ip.trim()) body.ip = ip.trim();
      if (prefill && port.trim()) body.port = Number(port);
      return api.createNode(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nodes"] });
      reset();
      onOpenChange(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit() {
    setError("");
    if (!name.trim()) return setError("Node name is required.");
    if (prefill && port.trim() && !/^\d+$/.test(port.trim())) {
      return setError("Port must be a number.");
    }
    mutation.mutate();
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-[460px]">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Add Node</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <Select
                selectedKey={protocol}
                onSelectionChange={(k) => setProtocol(String(k) as NodeProtocol)}
              >
                <Label>Protocol</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="snell" textValue="Snell">
                      Snell
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="ss2022" textValue="SS2022">
                      SS2022
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>

              {protocol === "snell" ? (
                <Select
                  selectedKey={version}
                  onSelectionChange={(k) => setVersion(String(k) as SnellVersion)}
                >
                  <Label>Snell version</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="6" textValue="V6">
                        V6 (latest beta)
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="5" textValue="V5">
                        V5 (stable)
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : (
                <Select
                  selectedKey={method}
                  onSelectionChange={(k) => setMethod(String(k) as SS2022Method)}
                >
                  <Label>SS2022 method</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {SS2022_METHODS.map((m) => (
                        <ListBox.Item key={m} id={m} textValue={m}>
                          {m}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}

              <TextField value={name} onChange={setName}>
                <Label>Node name</Label>
                <Input placeholder="e.g. Tokyo 01" />
              </TextField>

              <Switch isSelected={prefill} onChange={setPrefill}>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Switch.Content>
                  <Label className="text-sm">Pre-fill IP / Port</Label>
                </Switch.Content>
              </Switch>

              {prefill && (
                <div className="flex gap-3">
                  <TextField value={ip} onChange={setIp} className="flex-1">
                    <Label>IP / Host</Label>
                    <Input placeholder="1.2.3.4 or domain" />
                  </TextField>
                  <TextField value={port} onChange={setPort} className="w-28">
                    <Label>Port</Label>
                    <Input placeholder="port" inputMode="numeric" />
                  </TextField>
                </div>
              )}

              <Switch isSelected={tfo} onChange={setTfo}>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Switch.Content>
                  <Label className="text-sm">TCP Fast Open (tfo)</Label>
                </Switch.Content>
              </Switch>

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
              {mutation.isPending ? "Creating…" : "Create"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
