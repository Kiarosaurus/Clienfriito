# CLAUDE.md
 
## Convención de commits
 
Al crear commits en este repositorio:
 
- Usar prefijo de **conventional commit**: `feat:`, `fix:`, `refactor:`, `chore:`, etc.
- Mensaje **muy corto**, en inglés y en minúsculas después del prefijo.
  - Ejemplos: `feat: added tour guide`, `fix: fixed multiple dropdown not selecting values`
- **Un commit por cada cambio lógico** — si hay varios cambios no relacionados, hacer un commit separado para cada uno (no agruparlos).
- **No** agregar la línea `Co-Authored-By`.
- Commitear directo a la rama actual; no crear ramas.
- No hacer `git push` salvo que se pida explícitamente.
 
 ## Reglas de diseño del frontend

El dashboard React (`frontend/`) usa **Tailwind** como único sistema visual. Al tocar una vista:

1. **Una pantalla, una pregunta.** Resumen: "¿cómo están todas las aulas?". Aula: "¿qué pasa en esta aula?". Administración: "¿cómo configuro el sistema?".
2. **Todo dato dice de dónde viene:** aula, sensor y hora de la lectura. Nunca mezclar lecturas de varias aulas en un mismo valor o gráfico.
3. **Monitorear, simular y administrar van separados.** La simulación de lecturas y la recarga del modelo viven en Administración, no en las vistas de monitoreo.
4. **Cada elemento aparece una sola vez:** un indicador de conexión (real, no decorativo) y un reloj.
5. **Jerarquía de arriba abajo:** estado y alertas → valores actuales → historial → detalle.
6. **Tarjetas compactas** (~72 px de alto, todas iguales): etiqueta, valor y chip de estado. Sin cajas de iconos grandes.
7. **El color solo indica estado** y siempre va con texto o ícono. Sin filas de leyenda: la leyenda va en el propio gráfico o en el tooltip.
8. **Un gráfico por magnitud**, con ventana de tiempo (no por cantidad de puntos) y solo líneas de referencia con significado: setpoint y umbrales del nodo.
9. **Un solo sistema visual**, con clases comunes en `frontend/src/index.css` (`surface`, `field`, `btn-primary`, `chip-*`, `table-head`, `segmented`…) y componentes en `components/ui.tsx`. No inventar estilos sueltos.
   - **Fondos:** página `slate-950`; barra, menú, tarjetas y modales `slate-900` con borde `slate-800`; campos `slate-950`.
   - **Colores:** azul solo para acciones principales, selección y foco. Estados: verde (normal), ámbar (atención), naranja (elevado), rojo (alerta), celeste (informativo). Nada de morado, índigo, teal ni amarillo.
   - **Gráficos:** una serie en celeste, comparaciones en gris, colores de estado solo en umbrales.
   - **Texto:** tres tamaños (`text-xs`, `text-sm`, `text-xl`), máximo `font-semibold`, sin mayúsculas sostenidas.
   - **Forma:** `rounded-lg` en todo (modales `rounded-xl`, chips `rounded-full`); botones y campos de la misma altura; espaciado en múltiplos de 4 px.
10. **Todo en español** y con estados en lenguaje de usuario ("Enfriando", "En espera"), no códigos internos (`COOLING`, `STANDBY`).
11. **Diseñar para 100+ aulas.** Ninguna vista lista todas las aulas sin búsqueda, filtro, agrupación (edificio → piso) o paginación. El monitoreo muestra primero lo que requiere atención y resume lo normal en contadores ("panorama → filtrar → detalle a pedido"). Ninguna vista hace una petición por aula: el backend entrega los datos agregados.
