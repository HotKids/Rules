import { useMemo, useState } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  TextField,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SettingsResponse, SubscriptionFormat } from "@snell-panel/shared";
import { api } from "../api/client";
import { CopyButton } from "./CopyButton";

export function SubscriptionModal({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings,
    enabled: isOpen,
  });

  const [format, setFormat] = useState<SubscriptionFormat>("surge");
  const [flag, setFlag] = useState(true);
  const [filter, setFilter] = useState("");
  const [via, setVia] = useState("");

  const reset = useMutation({
    mutationFn: api.resetSubscribeToken,
    onSuccess: (d: SettingsResponse) => qc.setQueryData(["settings"], d),
  });

  const url = useMemo(() => {
    if (!settings.data) return "";
    const p = new URLSearchParams();
    p.set("token", settings.data.subscribe_token);
    p.set("format", format);
    if (!flag) p.set("flag", "false");
    if (filter.trim()) p.set("filter", filter.trim());
    // Relay (underlying-proxy) is Surge-only.
    if (via.trim() && format === "surge") p.set("via", via.trim());
    return `${window.location.origin}/api/subscribe?${p.toString()}`;
  }, [settings.data, format, flag, filter, via]);

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-[640px]">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Subscription</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Select
                  selectedKey={format}
                  onSelectionChange={(k) =>
                    setFormat(String(k) as SubscriptionFormat)
                  }
                >
                  <Label>Format</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="surge" textValue="Surge">
                        Surge
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="shadowrocket" textValue="Shadowrocket">
                        Shadowrocket
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="mihomo" textValue="Mihomo">
                        Mihomo
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>

                <Select
                  selectedKey={flag ? "on" : "off"}
                  onSelectionChange={(k) => setFlag(String(k) === "on")}
                >
                  <Label>Country flag</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="on" textValue="Show">
                        Show
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="off" textValue="Hide">
                        Hide
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>

                <TextField value={filter} onChange={setFilter}>
                  <Label>Filter (name contains)</Label>
                  <Input placeholder="optional" />
                </TextField>
                {format === "surge" && (
                  <TextField value={via} onChange={setVia}>
                    <Label>Relay (underlying-proxy)</Label>
                    <Input placeholder="optional" />
                  </TextField>
                )}
              </div>

              <TextField value={url} className="w-full">
                <Label>Subscription URL</Label>
                <Input readOnly className="font-mono text-xs" />
              </TextField>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="danger"
              isDisabled={reset.isPending}
              onPress={() => {
                if (
                  confirm(
                    "Reset the subscribe token? Existing subscription URLs will stop working.",
                  )
                ) {
                  reset.mutate();
                }
              }}
            >
              {reset.isPending ? "Resetting…" : "Reset token"}
            </Button>
            <CopyButton text={url} label="Copy URL" />
            <Button variant="tertiary" slot="close">
              Close
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
