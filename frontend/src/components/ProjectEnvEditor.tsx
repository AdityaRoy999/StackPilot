"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { Plus, Trash2, Upload } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mergeEnvVariables, parseEnvText } from "@/lib/env-files";

export interface ProjectEnvVar {
  key: string;
  value: string;
}

interface ProjectEnvEditorProps {
  title?: string;
  description?: string;
  envVars: ProjectEnvVar[];
  onChange: (envVars: ProjectEnvVar[]) => void;
}

export function ProjectEnvEditor({
  title = "Environment Variables",
  description = "Select env files or add variables manually. Later files override matching keys.",
  envVars,
  onChange,
}: ProjectEnvEditorProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const firstKeyInputRef = useRef<HTMLInputElement | null>(null);
  const focusNewRowRef = useRef(false);
  const [importing, setImporting] = useState(false);
  const [importedFiles, setImportedFiles] = useState<string[]>([]);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    if (!focusNewRowRef.current) {
      return;
    }

    focusNewRowRef.current = false;
    firstKeyInputRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    firstKeyInputRef.current?.focus();
  }, [envVars]);

  const setRow = (index: number, next: ProjectEnvVar) => {
    const copy = [...envVars];
    copy[index] = next;
    onChange(copy);
  };

  const addRow = () => {
    focusNewRowRef.current = true;
    onChange([{ key: "", value: "" }, ...envVars]);
  };

  const removeRow = (index: number) => onChange(envVars.filter((_, rowIndex) => rowIndex !== index));

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    setImportError("");
    setImporting(true);
    try {
      if (files.length > 10 || files.some(file => file.size > 1024 * 1024)) throw new Error("Select up to 10 env files, each under 1 MB.");
      const parsed = await Promise.all(files.map(async file => parseEnvText(await file.text())));
      if (parsed.some(variables => !variables.length)) throw new Error("Each selected file must contain at least one KEY=value variable.");
      const merged = mergeEnvVariables(envVars, ...parsed);
      if (merged.length > 1000) throw new Error("Import up to 1,000 variables at a time.");
      onChange(merged);
      setImportedFiles(files.map(file => file.name));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "The env files could not be read.");
    } finally {
      setImporting(false);
      input.value = "";
    }
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
            multiple
            aria-label="Select env files"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-[132px] justify-center"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            <AppIcon name="upload" fallback={Upload} className="mr-2 h-4 w-4"  />
            {importing ? "Reading files…" : "Select env files"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-[132px] justify-center"
            onClick={addRow}
            disabled={importing}
          >
            <AppIcon name="plus" fallback={Plus} className="mr-2 h-4 w-4"  />
            Add Variable
          </Button>
        </div>
        {!!importedFiles.length && <p role="status" className="break-words text-xs text-muted-foreground">Imported {importedFiles.join(", ")}</p>}
        {importError && <p role="alert" className="text-sm text-destructive">{importError}</p>}
      </div>

      <div className="space-y-2">
        {envVars.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No environment variables yet.
          </div>
        ) : (
          envVars.map((envVar, index) => (
            <div
              key={index}
              className="grid gap-2 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)_auto] md:items-center"
            >
              <Input
                ref={index === 0 ? firstKeyInputRef : undefined}
                value={envVar.key}
                onChange={(event) => setRow(index, { ...envVar, key: event.target.value })}
                placeholder="EMAILJS_SERVICE_ID"
                autoComplete="off"
                className="min-w-0"
                aria-label={`Variable ${index + 1} name`}
                disabled={importing}
              />
              <Input
                value={envVar.value}
                onChange={(event) => setRow(index, { ...envVar, value: event.target.value })}
                placeholder="value"
                autoComplete="off"
                className="min-w-0"
                aria-label={`Variable ${index + 1} value`}
                disabled={importing}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="justify-self-start md:justify-self-end"
                onClick={() => removeRow(index)}
                aria-label={`Remove variable ${index + 1}`}
                disabled={importing}
              >
                <AppIcon name="trash2" fallback={Trash2} className="h-4 w-4"  />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
