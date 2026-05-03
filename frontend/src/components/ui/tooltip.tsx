"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";

function TooltipProvider(props: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={250} closeDelay={80} {...props} />;
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

type TooltipContentProps = React.ComponentProps<typeof TooltipPrimitive.Popup> & {
  side?: React.ComponentProps<typeof TooltipPrimitive.Positioner>["side"];
  sideOffset?: React.ComponentProps<typeof TooltipPrimitive.Positioner>["sideOffset"];
};

function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className="z-[2147483647]">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-[2147483647] max-w-60 rounded-md border border-border bg-popover px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-md",
            "data-[side=bottom]:animate-in data-[side=bottom]:slide-in-from-top-1",
            "data-[side=left]:animate-in data-[side=left]:slide-in-from-right-1",
            "data-[side=right]:animate-in data-[side=right]:slide-in-from-left-1",
            "data-[side=top]:animate-in data-[side=top]:slide-in-from-bottom-1",
            className
          )}
          {...props}
        >
          {props.children}
          <TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
