import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, vi } from "vitest";

vi.mock("@shopify/polaris-icons", () => ({
  QuestionCircleIcon: () => <span data-icon-question />,
}));

// jsdom does not implement Blob URL APIs; stub for tests that download files.
if (typeof URL.createObjectURL !== "function") {
  Object.defineProperty(URL, "createObjectURL", {
    value: () => "blob:stub",
    writable: true,
    configurable: true,
  });
}
if (typeof URL.revokeObjectURL !== "function") {
  Object.defineProperty(URL, "revokeObjectURL", {
    value: () => {},
    writable: true,
    configurable: true,
  });
}

vi.mock("@shopify/app-bridge-react", () => ({
  NavMenu: ({ children }: PropsWithChildren) => <nav data-nav-menu>{children}</nav>,
  TitleBar: () => <div data-title-bar />,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

vi.mock("@shopify/polaris", () => {
  const sanitizeDomProps = (props: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (
        key.startsWith("data-") ||
        key.startsWith("aria-") ||
        key === "id" ||
        key === "className" ||
        key === "style" ||
        key === "role" ||
        key === "title" ||
        key === "name" ||
        key === "value" ||
        key === "placeholder" ||
        key === "href" ||
        key === "target" ||
        key === "rel" ||
        key === "disabled" ||
        key === "type" ||
        key === "checked" ||
        key === "defaultValue" ||
        key === "autoComplete" ||
        key === "htmlFor" ||
        key === "tabIndex" ||
        key.startsWith("on")
      ) {
        out[key] = value;
      }
    }
    return out;
  };
  const wrap =
    (Tag: keyof JSX.IntrinsicElements = "div") =>
    ({ children, ...rest }: PropsWithChildren<Record<string, unknown>>) => {
      const El = Tag as "div";
      return <El {...sanitizeDomProps(rest)}>{children}</El>;
    };
  return {
    AppProvider: ({ children }: PropsWithChildren) => <div data-polaris-app>{children}</div>,
    Badge: wrap("span"),
    Banner: ({
      children,
      title,
      tone,
      ...rest
    }: PropsWithChildren<{ title?: ReactNode; tone?: string } & Record<string, unknown>>) => (
      <div data-banner data-tone={tone} {...sanitizeDomProps(rest)}>
        {title ? <div data-banner-title>{title}</div> : null}
        {children}
      </div>
    ),
    BlockStack: wrap("div"),
    Box: wrap("div"),
    Button: ({
      children,
      onClick,
      submit,
      url,
      ...rest
    }: PropsWithChildren<
      { onClick?: () => void; submit?: boolean; url?: string } & Record<string, unknown>
    >) =>
      url ? (
        <a href={url} {...sanitizeDomProps(rest)}>
          {children}
        </a>
      ) : (
        <button
          type={submit ? "submit" : "button"}
          onClick={onClick}
          {...sanitizeDomProps(rest)}
        >
          {children}
        </button>
      ),
    ButtonGroup: wrap("div"),
    CalloutCard: wrap("div"),
    Card: wrap("div"),
    Collapsible: ({ children, open }: PropsWithChildren<{ open?: boolean }>) =>
      open ? <div data-open>{children}</div> : null,
    Divider: () => <hr />,
    FormLayout: wrap("div"),
    Icon: () => <span data-icon />,
    InlineStack: wrap("div"),
    Link: ({
      children,
      url,
      ...rest
    }: PropsWithChildren<{ url?: string } & Record<string, unknown>>) => (
      <a href={url as string} {...sanitizeDomProps(rest)}>
        {children}
      </a>
    ),
    Page: wrap("div"),
    Layout: { Section: wrap("section") },
    List: { Item: wrap("li") },
    Modal: Object.assign(
      ({
        children,
        open,
        onClose,
        title,
        primaryAction,
        secondaryActions,
      }: PropsWithChildren<{
        open?: boolean;
        onClose?: () => void;
        title?: ReactNode;
        primaryAction?: { content?: string; onAction?: () => void };
        secondaryActions?: { content?: string; onAction?: () => void }[];
      }>) =>
        open ? (
          <div role="dialog">
            <div data-modal-title>{title}</div>
            <button type="button" data-modal-close onClick={onClose}>
              close
            </button>
            <button type="button" data-modal-primary onClick={primaryAction?.onAction}>
              {primaryAction?.content}
            </button>
            {secondaryActions?.map((a, i) => (
              <button key={i} type="button" data-modal-secondary onClick={a.onAction}>
                {a.content}
              </button>
            ))}
            {children}
          </div>
        ) : null,
      { Section: wrap("div") },
    ),
    ProgressBar: () => <div role="progressbar" />,
    RangeSlider: ({
      onChange,
      value,
      ...rest
    }: {
      onChange?: (v: number) => void;
      value?: number;
    } & Record<string, unknown>) => (
      <input
        type="range"
        aria-label="range"
        value={value ?? 0}
        onChange={(e) => onChange?.(Number(e.target.value))}
        {...sanitizeDomProps(rest)}
      />
    ),
    SkeletonBodyText: () => <div data-skeleton />,
    Spinner: () => <span data-spinner />,
    Text: ({
      children,
      as: Comp = "span",
      ...rest
    }: PropsWithChildren<{ as?: keyof JSX.IntrinsicElements } & Record<string, unknown>>) => {
      const T = (Comp || "span") as "span";
      return <T {...sanitizeDomProps(rest)}>{children}</T>;
    },
    TextField: ({
      label,
      value,
      onChange,
      autoComplete,
      ...rest
    }: {
      label?: ReactNode;
      value?: string;
      onChange?: (v: string) => void;
      autoComplete?: string;
    } & Record<string, unknown>) => (
      <label>
        {label}
        <input
          aria-label={typeof label === "string" ? label : "field"}
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => onChange?.(e.target.value)}
          {...sanitizeDomProps(rest)}
        />
      </label>
    ),
    Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  };
});
