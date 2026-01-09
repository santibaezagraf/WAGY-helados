import Image from "next/image"

interface LogoProps {
  size?: "sm" | "md" | "lg" | "xl"
  className?: string
}

const sizeMap = {
  sm: { width: 60, height: 60 },
  md: { width: 100, height: 100 },
  lg: { width: 150, height: 150 },
  xl: { width: 200, height: 200 },
}

export function Logo({ size = "md", className = "" }: LogoProps) {
  const dimensions = sizeMap[size]
  
  return (
    <Image
      src="/wagy-logo-nombre.png"
      alt="WAGY Helados"
      width={dimensions.width}
      height={dimensions.height}
      className={className}
      priority
    />
  )
}