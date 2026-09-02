#!/bin/bash
# Push con retry para resolver problemas de timeout

cd /Users/raymonreddintone/Desktop/EGCHAT_NATIVA/server

echo "🚀 Intentando push a GitHub..."
echo "Commits pendientes: $(git log --oneline origin/main..HEAD | wc -l)"

# Intento 1: Push normal
echo "📤 Intento 1/3..."
if git push origin main 2>&1 | tee /tmp/git-push.log; then
    echo "✅ Push exitoso!"
    exit 0
fi

# Intento 2: Con timeout más corto
echo "⏱️  Intento 2/3 (con timeout)..."
sleep 5
if git push --progress origin main 2>&1 | tee -a /tmp/git-push.log; then
    echo "✅ Push exitoso!"
    exit 0
fi

# Intento 3: Forzar push (solo si es seguro)
echo "🔄 Intento 3/3..."
sleep 5
if git push --force-with-lease origin main 2>&1 | tee -a /tmp/git-push.log; then
    echo "✅ Push forzado exitoso!"
    exit 0
fi

echo "❌ Push falló después de 3 intentos"
echo "📋 Log guardado en /tmp/git-push.log"
exit 1
