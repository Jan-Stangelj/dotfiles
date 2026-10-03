#!/bin/sh

exec i3lock \
    --color=00090D \
    --inside-color=00090D \
    --ring-color=D9C3A9 \
    --line-color=00090D \
    --separator-color=00090D \
    --keyhl-color=7FB069 \
    --bshl-color=A54242 \
    --verif-color=7FB069 \
    --wrong-color=A54242 \
    --time-color=D9C3A9 \
    --date-color=707880 \
    --time-str="%H:%M" \
    --date-str="%a, %d %b" \
    --clock \
    --indicator \
    --radius=110 \
    --ring-width=5 \
    --time-font="AdwaitaMono Nerd Font" \
    --date-font="AdwaitaMono Nerd Font" \
    --time-size=48 \
    --date-size=18 \
    --verif-text="verifying..." \
    --wrong-text="incorrect password"

