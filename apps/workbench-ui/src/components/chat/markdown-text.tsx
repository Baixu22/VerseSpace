import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { type ComponentProps, memo } from "react";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];
const components: ComponentProps<typeof MarkdownTextPrimitive>["components"] = {
	table: ({ children }) => (
		<div className="my-4 max-w-full overflow-x-auto rounded-lg">
			<table>{children}</table>
		</div>
	),
};

const MarkdownTextImpl = () => (
	<MarkdownTextPrimitive
		remarkPlugins={remarkPlugins}
		className="aui-md"
		components={components}
	/>
);

export const MarkdownText = memo(MarkdownTextImpl);
