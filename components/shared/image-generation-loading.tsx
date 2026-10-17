import React from "react";
import { cn } from "@/lib/utils";

const waveDots = Array.from({ length: 22 * 22 }, (_, index) => {
  const column = index % 22, row = Math.floor(index / 22);
  const x = column * 18 - 9, y = row * 18 - 9;
  return { x, y, color: `hsl(${205 + column * 4.5} 82% 59%)`, delay: `${-(Math.hypot(x - 110, y - 140) * 0.012).toFixed(3)}s` };
});

/** Works both as a placeholder and as an overlay while replacing an existing image. */
export function ImageGenerationLoading({ overlay = false, label = "正在生成图片", className }: { overlay?: boolean; label?: string; className?: string }) {
  return <div role="status" aria-label={label} aria-busy="true" className={cn("image-generation-loading isolate grid place-items-center overflow-hidden bg-background/95 p-4 text-center text-muted-foreground", overlay ? "absolute inset-0 z-10 backdrop-blur-sm" : "relative h-full min-h-40 w-full", className)}>
    <div aria-hidden="true" className="image-generation-dots absolute inset-0">
      <svg viewBox="0 0 360 360" preserveAspectRatio="xMidYMid slice" className="block h-full w-full" focusable="false">
        {waveDots.map((dot, index) => <circle key={index} cx={dot.x} cy={dot.y} r="1.5" fill={dot.color} style={{ animationDelay: dot.delay }}/>) }
      </svg>
    </div>
    <div className="image-generation-caption relative z-10 isolate max-w-full space-y-2 px-5 py-3">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <p className="text-xs">完成后会自动显示</p>
    </div>
  </div>;
}
