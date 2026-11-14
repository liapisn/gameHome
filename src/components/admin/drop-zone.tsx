import { useId, useRef, useState } from "react";
import { ACCEPTED_IMAGE_TYPES } from "@/lib/image-resize";

export function DropZone({
  onFiles,
  multiple = false,
  disabled = false,
  label,
  sublabel,
  className = "",
}: {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  label: string;
  sublabel?: string;
  className?: string;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (list: FileList | null) => {
    if (!list || disabled) return;
    const files = Array.from(list).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
        over ? "border-[#c8643b] bg-[#c8643b]/5" : "border-black/15 hover:border-black/30"
      } ${disabled ? "pointer-events-none opacity-60" : ""} ${className}`}
    >
      <span className="text-sm font-medium">{label}</span>
      {sublabel && <span className="mt-1 text-xs text-neutral-500">{sublabel}</span>}
      <input
        ref={input}
        id={inputId}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
    </label>
  );
}
