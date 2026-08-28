import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { memo } from "react";
import remarkGfm from "remark-gfm";

const MarkdownTextImpl = () => (
	<MarkdownTextPrimitive
		remarkPlugins={[remarkGfm]}
		className="aui-md"
		components={{}}
	/>
);

export const MarkdownText = memo(MarkdownTextImpl);
