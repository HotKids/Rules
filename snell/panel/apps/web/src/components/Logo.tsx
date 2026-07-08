export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      className={className}
      role="img"
      aria-label="Snell Panel logo"
    >
      <defs>
        <linearGradient
          id="snell-logo-g"
          x1="620"
          y1="120"
          x2="380"
          y2="900"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#3DE8B4" />
          <stop offset="1" stopColor="#16BE55" />
        </linearGradient>
      </defs>
      <g fill="url(#snell-logo-g)">
        <rect x="150" y="585" width="118" height="150" rx="59" />
        <rect x="305" y="455" width="118" height="385" rx="59" />
        <rect x="453" y="235" width="118" height="558" rx="59" />
        <rect x="601" y="165" width="118" height="400" rx="59" />
        <rect x="756" y="270" width="118" height="172" rx="59" />
      </g>
    </svg>
  );
}
