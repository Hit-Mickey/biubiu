import Markdown from "react-markdown";

import ScrollContainer from "../scroll-container";

const Typography = ({ content }: { content: string }) => (
  <ScrollContainer>
    <div className="prose dark:prose-invert px-6">
      <Markdown
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={event => {
                event.preventDefault();
                if (href?.startsWith("https://") || href?.startsWith("http://"))
                  void window.electron.openExternal(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  </ScrollContainer>
);

export default Typography;
