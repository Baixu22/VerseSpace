/**
 * Shared icon typing for the unified icon layer.
 *
 * Every icon reachable from `@/components/icon` is assignable to {@link AppIcon},
 * so this is the type to use for icon props, maps, and render-prop slots.
 */
import type { SVGProps } from "react";
import type { IconComponent } from "reicon-react";

/** Props understood by Reicon-backed icons; compat icons accept a subset. */
export interface AppIconProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
	color?: string;
	/** Pixel size when numeric. Default `24`. */
	size?: number | string;
	/** Reicon weight. Reicon-backed icons only; compat icons ignore it. */
	weight?: "Outline" | "Filled";
	/** Stroke emphasis. Reicon-backed icons restyle their outline to match. */
	strokeWidth?: number | string;
	/** Reicon dual-tone secondary color. Reicon-backed icons only. */
	secondaryColor?: string;
}

/**
 * The unified icon component type. Reicon-backed and lucide compat icons both
 * satisfy it, because `AppIconProps` is a structural superset of lucide's.
 */
export type AppIcon = IconComponent;
