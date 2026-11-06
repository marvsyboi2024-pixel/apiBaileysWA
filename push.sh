#!/data/data/com.termux/files/usr/bin/bash
# Usage: bash push.sh "optional commit message"
cd "$(dirname "$0")" || exit 1
MSG="${1:-Update: dashboard AI fixes, localhost dev key, Groq model auto-select}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[!] This folder is not a git repo."; exit 1
fi

# keep secrets and junk out of GitHub
touch .gitignore
for p in ".env" "node_modules/" "*.bak" "bot.old.js" "bot.before-*.js" "patch*.py" "*.log"; do
  grep -qxF "$p" .gitignore || echo "$p" >> .gitignore
done
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "[!] .env was tracked by git. Removing it from git (the file stays on your phone)."
  git rm --cached -q .env
fi

git add -A
if git diff --cached --quiet; then
  echo "[i] Nothing new to commit."
else
  git commit -q -m "$MSG" && echo "[OK] Committed: $MSG"
fi

BR=$(git rev-parse --abbrev-ref HEAD)
git fetch -q origin 2>/dev/null || { echo "[!] Could not reach GitHub. Check internet / token."; exit 1; }
BEHIND=$(git rev-list --count "HEAD..origin/$BR" 2>/dev/null || echo 0)
AHEAD=$(git rev-list --count "origin/$BR..HEAD" 2>/dev/null || echo 0)
echo "[i] Branch $BR: GitHub has $BEHIND newer commit(s), you have $AHEAD to send."

if [ "$BEHIND" -gt 0 ]; then
  echo "[i] Merging GitHub's newer commits first..."
  if ! git pull --rebase -q origin "$BR"; then
    git rebase --abort 2>/dev/null
    echo "[!] GitHub's version conflicts with yours. NOTHING was pushed."
    echo "    Copy this screen and send it to Claude."
    exit 1
  fi
fi

read -r -p "Push to GitHub now? (y/n) " A
if [ "$A" = "y" ]; then
  git push -u origin "$BR" && echo "[DONE] Pushed to GitHub."
else
  echo "Skipped push (your commit is saved locally)."
fi
