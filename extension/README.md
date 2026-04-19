# ChatGPT Canvas — Extensión Chrome

Transforma el chat de ChatGPT en un **dashboard visual** con bloques interconectados, bifurcaciones de conversación y herramientas de anotación.

---

## Instalación (modo desarrollador)

### 1. Descargar Fabric.js
La extensión necesita `fabric.min.js` en la carpeta raíz.

Descárgalo desde:
```
https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js
```
Guárdalo como `extension/fabric.min.js`.

### 2. Crear iconos
Necesitas 3 archivos PNG en `extension/icons/`:
- `icon16.png`  — 16×16 px
- `icon48.png`  — 48×48 px
- `icon128.png` — 128×128 px

Puedes usar cualquier herramienta online para generarlos (p.ej. https://favicon.io).

### 3. Cargar en Chrome
1. Abre Chrome y ve a `chrome://extensions`
2. Activa **Modo de desarrollador** (toggle arriba a la derecha)
3. Haz clic en **"Cargar extensión sin empaquetar"**
4. Selecciona la carpeta `extension/`
5. La extensión aparecerá en la barra de Chrome

### 4. Usar la extensión
1. Ve a [chatgpt.com](https://chatgpt.com) o [chat.openai.com](https://chat.openai.com)
2. Abre el popup de la extensión (icono ⬡ en la barra)
3. Activa el toggle **"Canvas activo"**
4. El canvas reemplaza la zona central de mensajes

---

## Estructura de archivos

```
extension/
├── manifest.json       — Configuración de la extensión
├── content.js          — Núcleo: canvas, bloques, bifurcaciones
├── styles.css          — Estilos del dashboard
├── popup.html          — UI del popup
├── popup.js            — Lógica del popup
├── fabric.min.js       — ⚠ Debes descargarlo (ver arriba)
└── icons/
    ├── icon16.png      — ⚠ Debes crearlo
    ├── icon48.png      — ⚠ Debes crearlo
    └── icon128.png     — ⚠ Debes crearlo
```

---

## Funcionalidades

### Bloques de conversación
- Cada mensaje del usuario = **título** del bloque
- Respuesta de ChatGPT = **contenido** del bloque
- **Minimizable** (botón ─), **redimensionable** (esquina inferior derecha), **reposicionable** (arrastrar por el header)

### Bifurcaciones
- Botón **`+`** en cada bloque → marca ese bloque como punto de bifurcación
- El siguiente mensaje que envíes crea un **bloque hijo** conectado con una línea curva
- Se visualiza el árbol completo de conversaciones ramificadas

### Herramientas del canvas
| Herramienta | Función |
|---|---|
| ↖ Seleccionar | Mover bloques, hacer pan del canvas |
| 🖊 Resaltador | Selecciona texto dentro de un bloque para resaltarlo en amarillo |
| U̲ Subrayar | Selecciona texto para subrayarlo |
| T Texto | Clic en el canvas para crear una nota adhesiva |
| ✏ Dibujo | Dibuja libremente sobre el canvas |
| + / − | Zoom in / out |
| ⊡ Ajustar | Centra la vista en los bloques |

### Persistencia
- El estado se guarda automáticamente con `chrome.storage.local`
- Al reabrir un chat, el canvas se restaura tal como lo dejaste
- Exporta todos los datos a JSON desde el popup

---

## Notas técnicas

- **Sin coste de API**: la extensión solo lee el DOM de ChatGPT e intercepta la UI
- **No modifica el sidebar izquierdo** (historial, carpetas) ni la **barra de input** inferior
- Compatible con el selector de modelo de ChatGPT en la barra superior
- Detecta navegación SPA (cambio de chat) y actualiza el canvas automáticamente

---

## Limitaciones conocidas

- Si OpenAI cambia los selectores del DOM, la captura de mensajes puede necesitar ajuste en `getConversationTurns()` en `content.js`
- Las bifurcaciones de chats importados (anteriores a activar el canvas) se muestran como árbol lineal; solo las bifurcaciones nuevas crean ramas reales
- El dibujo libre no persiste entre sesiones (limitación del canvas HTML5 sin serialización adicional)
