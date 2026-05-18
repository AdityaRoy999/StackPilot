'use client';

import { useState } from "react";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogFooter, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger 
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Loader2, AlertTriangle, Copy } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { toast } from "sonner";
import { AxiosError } from "axios";

interface DeleteProjectDialogProps {
  projectId: string;
  projectName: string;
}

export function DeleteProjectDialog({ projectId, projectName }: DeleteProjectDialogProps) {
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await api.delete(`/projects/${projectId}`);
      return res.data;
    },
    onSuccess: () => {
      toast.success(`Project "${projectName}" deleted successfully`);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      setConfirmName("");
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to delete project"
          : "Failed to delete project";
      toast.error(message);
    }
  });

  const isConfirmed = confirmName === projectName;
  const copyConfirmationText = async () => {
    try {
      await navigator.clipboard.writeText(projectName);
      setConfirmName(projectName);
      toast.success("Confirmation text copied");
    } catch {
      toast.error("Unable to copy confirmation text");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(val) => { setOpen(val); if (!val) setConfirmName(""); }}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
            <Trash2 className="h-4 w-4" />
          </Button>
        }
      />
      <DialogContent className="!w-[min(94vw,680px)] !max-w-[680px] overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6">
          <div className="mx-auto w-14 h-14 bg-destructive/10 rounded-full flex items-center justify-center mb-4 border border-destructive/20">
            <AlertTriangle className="h-7 w-7 text-destructive" />
          </div>
          <DialogTitle className="text-center text-xl font-bold text-foreground tracking-tight">Delete Project?</DialogTitle>
          <DialogDescription className="text-center">
            This action is permanent. To confirm, please type <span className="font-bold text-foreground">&quot;{projectName}&quot;</span> below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-sm text-muted-foreground">
              Confirmation text: <span className="font-medium text-foreground">{projectName}</span>
            </span>
            <Button type="button" variant="outline" size="sm" onClick={copyConfirmationText} className="shrink-0">
              <Copy className="mr-2 h-3.5 w-3.5" />
              Copy
            </Button>
          </div>
          <Input
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder="Type project name here..."
            className="focus-visible:border-destructive focus-visible:ring-destructive/20"
          />
        </div>

        <DialogFooter className="border-t border-border bg-muted/30 px-6 py-5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending || !isConfirmed}
            variant="destructive"
            className="flex-1"
          >
            {deleteMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4 mr-2" />
            )}
            Delete Permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
