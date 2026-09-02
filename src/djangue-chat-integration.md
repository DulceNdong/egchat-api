# Mi Djangue - Integración de Chat Grupal

## Resumen

Cuando se crea un djangue, automáticamente se crea un grupo de chat en EGChat para que los integrantes puedan comunicarse. Todos los miembros del djangue se agregan automáticamente al grupo de chat.

## Flujo de Integración

### 1. Al crear un Djangue (API)

Cuando el Administrador crea un djangue, el backend debe:

```javascript
// routes/djangue.js
router.post('/', async (req, res) => {
  try {
    // 1. Crear el djangue
    const { data: djangue, error: djangueError } = await supabase
      .from('djangue_groups')
      .insert({
        name: req.body.name,
        description: req.body.description,
        logo_url: req.body.logo_url,
        // ... otros campos
        owner_id: req.user.id,
      })
      .select()
      .single();

    if (djangueError) throw djangueError;

    // 2. Crear grupo de chat asociado
    const { data: chatGroup, error: chatError } = await supabase
      .from('groups')
      .insert({
        name: `💰 ${req.body.name}`,
        description: `Chat del djangue: ${req.body.description || 'Caja de ahorro grupal'}`,
        avatar_url: req.body.logo_url,
        created_by: req.user.id,
        group_type: 'djangue', // Nuevo tipo de grupo
        is_private: true,
      })
      .select()
      .single();

    if (chatError) throw chatError;

    // 3. Vincular djangue con chat
    await supabase
      .from('djangue_groups')
      .update({ chat_group_id: chatGroup.id })
      .eq('id', djangue.id);

    // 4. Agregar al creador como miembro del chat
    await supabase
      .from('group_members')
      .insert({
        group_id: chatGroup.id,
        user_id: req.user.id,
        role: 'admin',
      });

    res.json({ ...djangue, chat_group_id: chatGroup.id });
  } catch (error) {
    console.error('Error creating djangue:', error);
    res.status(500).json({ error: error.message });
  }
});
```

### 2. Al agregar un integrante al Djangue

Cuando el Secretario agrega un miembro:

```javascript
// routes/djangue.js
router.post('/:id/add-member', async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.body;

    // 1. Buscar usuario por teléfono
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // 2. Obtener el djangue
    const { data: djangue } = await supabase
      .from('djangue_groups')
      .select('chat_group_id, current_turn, members:djangue_members(turn_order)')
      .eq('id', id)
      .single();

    // 3. Agregar como miembro del djangue
    const nextTurnOrder = (djangue.members?.length || 0) + 1;
    
    await supabase
      .from('djangue_members')
      .insert({
        group_id: id,
        user_id: user.id,
        turn_order: nextTurnOrder,
      });

    // 4. Agregar al grupo de chat
    if (djangue.chat_group_id) {
      await supabase
        .from('group_members')
        .insert({
          group_id: djangue.chat_group_id,
          user_id: user.id,
          role: 'member',
        });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error adding member:', error);
    res.status(500).json({ error: error.message });
  }
});
```

### 3. Al remover un integrante del Djangue

```javascript
router.delete('/:id/remove-member', async (req, res) => {
  try {
    const { id } = req.params;
    const { member_id } = req.body;

    // 1. Obtener info del miembro
    const { data: member } = await supabase
      .from('djangue_members')
      .select('user_id')
      .eq('id', member_id)
      .single();

    // 2. Obtener el chat_group_id
    const { data: djangue } = await supabase
      .from('djangue_groups')
      .select('chat_group_id')
      .eq('id', id)
      .single();

    // 3. Remover del djangue
    await supabase
      .from('djangue_members')
      .delete()
      .eq('id', member_id);

    // 4. Remover del chat grupal
    if (djangue.chat_group_id && member) {
      await supabase
        .from('group_members')
        .delete()
        .eq('group_id', djangue.chat_group_id)
        .eq('user_id', member.user_id);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

## Actualización del Esquema de Base de Datos

### Agregar tipo de grupo 'djangue'

```sql
-- Modificar tabla groups para soportar tipo djangue
ALTER TABLE groups ADD COLUMN IF NOT EXISTS group_type TEXT DEFAULT 'regular' 
  CHECK (group_type IN ('regular', 'djangue', 'broadcast'));

-- Índice para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_groups_type ON groups(group_type);
```

## UI - Botón de Chat en el Djangue

Agregar botón flotante en `djangue-detail.tsx`:

```typescript
// Dentro del componente DjangueDetailScreen
const openChat = () => {
  if (data?.chat_group_id) {
    router.push({ 
      pathname: '/chat/[id]', 
      params: { id: data.chat_group_id } 
    } as any);
  }
};

// En el JSX, antes del closing tag:
{data?.chat_group_id && (
  <TouchableOpacity
    style={{
      position: 'absolute',
      bottom: 20,
      right: 20,
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: '#6366f1',
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 8,
    }}
    onPress={openChat}
    activeOpacity={0.8}
  >
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none"
      stroke="#fff" strokeWidth={2} strokeLinecap="round">
      <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Svg>
  </TouchableOpacity>
)}
```

## Características del Chat de Djangue

### Mensajes del sistema automáticos

Enviar mensajes automáticos al chat grupal cuando:

1. **Alguien cotiza:**
```javascript
await sendSystemMessage(
  djangue.chat_group_id,
  `✅ ${member.full_name} cotizó ${quota_amount} ${currency}`
);
```

2. **Se cierra un periodo:**
```javascript
await sendSystemMessage(
  djangue.chat_group_id,
  `🎉 Periodo ${current_turn} cerrado. ${beneficiary.full_name} recibió ${payout_amount} ${currency}`
);
```

3. **Alguien se justifica:**
```javascript
await sendSystemMessage(
  djangue.chat_group_id,
  `🔔 ${member.full_name} notificó que no podrá cotizar a tiempo: "${note}"`
);
```

4. **Se aplica una mora:**
```javascript
await sendSystemMessage(
  djangue.chat_group_id,
  `⚠️ Se aplicó mora de ${penalty_amount} ${currency} a ${member.full_name}`
);
```

### Función helper para mensajes del sistema

```javascript
async function sendSystemMessage(groupId, text) {
  try {
    await supabase
      .from('messages')
      .insert({
        group_id: groupId,
        sender_id: null, // Mensaje del sistema
        type: 'system',
        text,
        created_at: new Date().toISOString(),
      });
  } catch (error) {
    console.error('Error sending system message:', error);
  }
}
```

## Badge de "Chat del Djangue"

En la UI del chat, mostrar un badge especial si es un chat de djangue:

```typescript
// En ChatConversation.tsx o similar
{group.group_type === 'djangue' && (
  <View style={{
    backgroundColor: '#C9A227',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginLeft: 8,
  }}>
    <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>
      💰 Djangue
    </Text>
  </View>
)}
```

## Notificaciones de Chat

Las notificaciones de chat normales de EGChat funcionarán automáticamente. Los miembros recibirán notificaciones push cuando:
- Alguien envía un mensaje
- Hay mensajes del sistema (cotizaciones, cierres, etc.)

## Testing

1. Crear un djangue
2. Verificar que se creó el grupo de chat en la tabla `groups`
3. Agregar miembros al djangue
4. Verificar que aparecen en `group_members`
5. Abrir el chat desde el djangue
6. Enviar mensajes
7. Simular eventos (pago, cierre) y verificar mensajes del sistema

## Resumen de Cambios Necesarios

### Base de datos:
- ✅ Ya existe `chat_group_id` en `djangue_groups`
- ⚠️ Agregar `group_type` a tabla `groups`

### Backend:
- ✅ Crear grupo de chat al crear djangue
- ✅ Agregar miembros al chat cuando se unen al djangue
- ✅ Remover del chat cuando se eliminan del djangue
- ⚠️ Implementar `sendSystemMessage` helper
- ⚠️ Llamar `sendSystemMessage` en eventos clave

### Frontend:
- ⚠️ Agregar botón flotante de chat en `djangue-detail.tsx`
- ⚠️ Mostrar badge "Djangue" en chats de tipo djangue
- ⚠️ (Opcional) Vista previa de chat en el dashboard del djangue
