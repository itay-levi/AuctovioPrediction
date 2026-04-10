import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, vi } from "vitest";

vi.mock("@shopify/polaris-icons", () => ({
  QuestionCircleIcon: () => <span data-icon-question />,
}));

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
  const wrap =
    (Tag: keyof JSX.IntrinsicElements = "div") =>
    ({ children, ...rest }: PropsWithChildren<Record<string, unknown>>) => {
      const El = Tag;
      return <El {...(rest as object)}>{children}</El>;
    };
  return {
    AppProvider: ({ children }: PropsWithChildren) => <div data-polaris-app>{children}</div>,
    Badge: wrap("span"),
    Banner: wrap("div"),
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
        <a href={url} {...(rest as object)}>
          {children}
        </a>
      ) : (
        <button type={submit ? "submit" : "button"} onClick={onClick} {...(rest as object)}>
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
      <a href={url as string} {...(rest as object)}>
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
        {...(rest as object)}
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
      return <T {...(rest as object)}>{children}</T>;
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
          {...(rest as object)}
        />
      </label>
    ),
    Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  };
});
