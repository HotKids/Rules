import { useState } from "react";
import { Button } from "@heroui/react";

export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size="sm"
      variant="secondary"
      isDisabled={!text}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? "Copied!" : label}
    </Button>
  );
}
