"use client"

import * as React from "react"
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"

interface TruncatedTextProps {
    text: string | null | undefined
    maxLength?: number
    className?: string
}

export function TruncatedText({ text, maxLength = 30, className = "" }: TruncatedTextProps) {
    if (!text) return <span className={className}>-</span>

    const shouldTruncate = text.length > maxLength
    const displayText = shouldTruncate ? `${text.slice(0, maxLength)}...` : text

    if (!shouldTruncate) {
        return <span className={className}>{text}</span>
    }

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className={`cursor-help ${className}`}>
                        {displayText}
                    </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-md">
                    <p className="whitespace-pre-wrap break-words">{text}</p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    )
}
