"use client";

import { cn } from "@/lib/utils";
import type { MotionProps } from "motion/react";
import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { memo, useMemo } from "react";

type MotionHTMLProps = MotionProps & Record<string, unknown>;
type ShimmerMotionComponent = React.ComponentType<
  MotionHTMLProps & { children: string }
>;

/**
 * `motion.create()` builds a component, so calling it during render trips
 * react(static-components). The `motion` proxy instead caches one component per
 * tag and returns it on property access, which keeps identity stable across
 * renders without pre-building a constant for every tag.
 *
 * The union is deliberately narrower than `ElementType`: indexing the proxy
 * with an arbitrary element would type-check and then render something else, so
 * an unsupported tag should fail to compile rather than degrade silently.
 */
type ShimmerTag =
  | "p"
  | "span"
  | "div"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6";

export interface TextShimmerProps {
  children: string;
  as?: ShimmerTag;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  const MotionComponent = motion[Component] as ShimmerMotionComponent;

  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
