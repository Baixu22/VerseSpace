import { MotionConfig } from "motion/react";
import { ChatProvider } from "./chat/provider";
import { WorkbenchShell } from "./components/chat/workbench-shell";
import { TooltipProvider } from "./components/ui/tooltip";
import { TWEEN_FAST } from "./lib/motion";

export default function App() {
	return (
		<MotionConfig reducedMotion="user" transition={TWEEN_FAST}>
			<TooltipProvider>
				<ChatProvider>
					<WorkbenchShell />
				</ChatProvider>
			</TooltipProvider>
		</MotionConfig>
	);
}
