"use client";

import { ChangeEvent, useRef } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ProjectEnvVar {
  key: string;
  value: string;
}

function parseEnvText(text: string): ProjectEnvVar[] {
  const lines = text.split(/\r?\n/);
  const envVars: ProjectEnvVar[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const exportLine = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = exportLine.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = exportLine.slice(0, separator).trim();
    let value = exportLine.slice(separator + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    envVars.push({ key, value });
  }

  return envVars.sort((left, right) => left.key.localeCompare(right.key));
}

interface ProjectEnvEditorProps {
  title?: string;
  description?: string;
  envVars: ProjectEnvVar[];
  onChange: (envVars: ProjectEnvVar[]) => void;
}

export function ProjectEnvEditor({
  title = "Environment Variables",
  description = "Add key/value pairs manually or upload an existing env file.",
  envVars,
  onChange,
}: ProjectEnvEditorProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const setRow = (index: number, next: ProjectEnvVar) => {
    const copy = [...envVars];
    copy[index] = next;
    onChange(copy);
  };

  const addRow = () => onChange([{ key: "", value: "" }, ...envVars]);

  const removeRow = (index: number) => onChange(envVars.filter((_, rowIndex) => rowIndex !== index));

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const contents = await file.text();
    const parsed = parseEnvText(contents);
    onChange(parsed);
    event.target.value = "";
  };

  return (
    <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </Label>
          <p className="text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".env,.production,.local,.txt"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-[132px] justify-center"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload Env File
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-[132px] justify-center"
            onClick={addRow}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Variable
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {envVars.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No environment variables yet.
          </div>
        ) : (
          envVars.map((envVar, index) => (
            <div
              key={`${envVar.key}-${index}`}
              className="grid gap-2 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)_auto] md:items-center"
            >
              <Input
                value={envVar.key}
                onChange={(event) => setRow(index, { ...envVar, key: event.target.value })}
                placeholder="EMAILJS_SERVICE_ID"
                autoComplete="off"
                className="min-w-0"
              />
              <Input
                value={envVar.value}
                onChange={(event) => setRow(index, { ...envVar, value: event.target.value })}
                placeholder="value"
                autoComplete="off"
                className="min-w-0"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="justify-self-start md:justify-self-end"
                onClick={() => removeRow(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
