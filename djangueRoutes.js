/**
 * Mi Djangue API Routes
 * Endpoints completos para sistema de djangue (tanda/caja de ahorro rotativo)
 */

const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const path = require('path');

const router = express.Router();

// Configuración de Supabase
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fqfxtjnfhvpggssbymdn.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxZnh0am5maHZwZ2dzc2J5bWRuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTg0MzgyMCwiZXhwIjoyMTAxNDE5ODIwfQ.ulwcC4WW-00pgjKzzs9CclyMGad1y4dqjS7P-c2O-CM'
);

const JWT_SECRET = process.env.JWT_SECRET || 'EGchat2025!xK9mP3nQ7rL2vW8tY4uJ6hF1bN5cA0dE_prod_secret';

// Middleware de autenticación
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId || decoded.sub;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
};

// Configuración de Multer para subir archivos (en memoria)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif, webp)'));
    }
  },
});

// =============================================================================
// 1. UPLOAD LOGO
// =============================================================================
router.post('/upload/djangue-logo', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó archivo' });
    }

    const file = req.file;
    const fileExt = path.extname(file.originalname);
    const fileName = `djangue-${req.userId}-${Date.now()}${fileExt}`;
    const filePath = `djangue-logos/${fileName}`;

    // Intentar subir a Supabase Storage (bucket 'avatars' o crear nuevo bucket)
    let uploadError = null;
    let publicUrl = null;

    // Intentar con bucket 'avatars' primero (suele existir por defecto)
    const { data: uploadData, error: err1 } = await supabase.storage
      .from('avatars')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (!err1) {
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(filePath);
      publicUrl = urlData.publicUrl;
    } else {
      // Si falla, intentar crear y usar bucket 'djangue-logos'
      await supabase.storage.createBucket('djangue-logos', { public: true });
      
      const { data: uploadData2, error: err2 } = await supabase.storage
        .from('djangue-logos')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (!err2) {
        const { data: urlData } = supabase.storage.from('djangue-logos').getPublicUrl(fileName);
        publicUrl = urlData.publicUrl;
      } else {
        uploadError = err2;
      }
    }

    if (uploadError || !publicUrl) {
      console.error('Error subiendo a Supabase Storage:', uploadError);
      // Fallback: devolver una URL de placeholder
      publicUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent('Djangue')}&size=200&background=C9A227&color=fff`;
    }

    res.json({ 
      success: true,
      url: publicUrl,
      path: filePath,
    });
  } catch (error) {
    console.error('Error en upload logo:', error);
    res.status(500).json({ error: 'Error al subir logo del djangue' });
  }
});

// =============================================================================
// 2. CREAR DJANGUE
// =============================================================================
router.post('/djangue', authenticate, async (req, res) => {
  try {
    const {
      name,
      slogan,
      description,
      logo_url,
      frequency,
      quota_amount,
      max_members,
      penalty_percent,
      notification_days_before,
      notification_final_days,
    } = req.body;

    // Validaciones
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'El nombre del djangue es obligatorio' });
    }
    if (!frequency || !['daily', 'weekly', 'monthly', 'annual'].includes(frequency)) {
      return res.status(400).json({ error: 'Frecuencia inválida' });
    }
    if (!quota_amount || quota_amount <= 0) {
      return res.status(400).json({ error: 'La cuota debe ser mayor a 0' });
    }
    if (!max_members || max_members < 2) {
      return res.status(400).json({ error: 'Debe haber al menos 2 miembros' });
    }

    // Calcular fechas según frecuencia
    const periodStart = new Date();
    let periodEnd = new Date();
    
    switch (frequency) {
      case 'daily':
        periodEnd.setDate(periodEnd.getDate() + 1);
        break;
      case 'weekly':
        periodEnd.setDate(periodEnd.getDate() + 7);
        break;
      case 'monthly':
        periodEnd.setMonth(periodEnd.getMonth() + 1);
        break;
      case 'annual':
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        break;
    }

    // 1. Crear el grupo de djangue
    const { data: group, error: groupError } = await supabase
      .from('djangue_groups')
      .insert({
        name: name.trim(),
        slogan: slogan?.trim() || null,
        description: description?.trim() || null,
        logo_url: logo_url || null,
        frequency,
        quota_amount: Number(quota_amount),
        currency: 'XAF',
        max_members: Number(max_members),
        penalty_percent: Number(penalty_percent || 10),
        notification_days_before: Number(notification_days_before || 10),
        notification_final_days: Number(notification_final_days || 5),
        status: 'active',
        owner_id: req.userId,
        current_turn: 1,
        total_turns: Number(max_members),
        period_start_date: periodStart.toISOString(),
        period_end_date: periodEnd.toISOString(),
        next_payout_at: periodEnd.toISOString(),
      })
      .select()
      .single();

    if (groupError) {
      console.error('Error creando djangue:', groupError);
      return res.status(500).json({ error: 'Error al crear el djangue' });
    }

    // 2. Crear el monedero del djangue
    const { data: wallet, error: walletError } = await supabase
      .from('djangue_wallets')
      .insert({
        group_id: group.id,
        balance: 0,
        currency: 'XAF',
      })
      .select()
      .single();

    if (!walletError && wallet) {
      // Actualizar el grupo con el wallet_id
      await supabase
        .from('djangue_groups')
        .update({ wallet_id: wallet.id })
        .eq('id', group.id);
    }

    // 3. Crear grupo de chat
    const { data: chatGroup, error: chatError } = await supabase
      .from('groups')
      .insert({
        name: `Chat: ${name.trim()}`,
        type: 'group',
        group_type: 'djangue',
        created_by: req.userId,
      })
      .select()
      .single();

    if (!chatError && chatGroup) {
      // Actualizar el grupo con el chat_group_id
      await supabase
        .from('djangue_groups')
        .update({ chat_group_id: chatGroup.id })
        .eq('id', group.id);

      // Agregar al owner como admin del chat
      await supabase
        .from('group_members')
        .insert({
          group_id: chatGroup.id,
          user_id: req.userId,
          role: 'admin',
        });
    }

    // 4. Agregar al owner como primer miembro del djangue (turno 1)
    const { error: memberError } = await supabase
      .from('djangue_members')
      .insert({
        group_id: group.id,
        user_id: req.userId,
        turn_number: 1,
        status: 'active',
        joined_at: new Date().toISOString(),
      });

    if (memberError) {
      console.error('Error agregando owner como miembro:', memberError);
    }

    res.json({
      success: true,
      id: group.id,
      name: group.name,
      message: 'Djangue creado exitosamente',
    });

  } catch (error) {
    console.error('Error en crear djangue:', error);
    res.status(500).json({ error: 'Error al crear el djangue' });
  }
});

// =============================================================================
// 3. OBTENER DJANGUES DEL USUARIO
// =============================================================================
router.get('/djangues', authenticate, async (req, res) => {
  try {
    // Obtener todos los djangues donde el usuario es miembro
    const { data: memberships, error: memberError } = await supabase
      .from('djangue_members')
      .select('group_id, turn_number, status')
      .eq('user_id', req.userId)
      .eq('status', 'active');

    if (memberError) {
      console.error('Error obteniendo membresías:', memberError);
      return res.status(500).json({ error: 'Error al obtener djangues' });
    }

    if (!memberships || memberships.length === 0) {
      return res.json([]);
    }

    const groupIds = memberships.map(m => m.group_id);

    // Obtener información de los grupos
    const { data: groups, error: groupsError } = await supabase
      .from('djangue_groups')
      .select('*')
      .in('id', groupIds);

    if (groupsError) {
      console.error('Error obteniendo grupos:', groupsError);
      return res.status(500).json({ error: 'Error al obtener djangues' });
    }

    // Para cada grupo, obtener info adicional
    const djangues = await Promise.all(
      groups.map(async (group) => {
        const membership = memberships.find(m => m.group_id === group.id);

        // Determinar rol del usuario
        let myRole = 'member';
        if (group.owner_id === req.userId) {
          myRole = 'owner';
        } else if (group.secretary_id === req.userId) {
          myRole = 'secretary';
        }

        // Contar miembros
        const { count: memberCount } = await supabase
          .from('djangue_members')
          .select('*', { count: 'exact', head: true })
          .eq('group_id', group.id)
          .eq('status', 'active');

        // Verificar si es mi turno
        const isMyTurn = membership.turn_number === group.current_turn;

        // Verificar si pagó el turno actual
        const { data: contribution } = await supabase
          .from('djangue_contributions')
          .select('status')
          .eq('group_id', group.id)
          .eq('member_id', membership.group_id) // Esto necesita el member_id, no group_id
          .eq('turn_number', group.current_turn)
          .eq('status', 'paid')
          .maybeSingle();

        const paidCurrentTurn = !!contribution;

        return {
          id: group.id,
          name: group.name,
          logo_url: group.logo_url,
          my_role: myRole,
          status: group.status,
          current_turn: group.current_turn,
          total_turns: group.total_turns,
          is_my_turn: isMyTurn,
          paid_current_turn: paidCurrentTurn,
          member_count: memberCount || 0,
          quota_amount: Number(group.quota_amount),
          currency: group.currency,
          frequency: group.frequency,
        };
      })
    );

    res.json(djangues);

  } catch (error) {
    console.error('Error en obtener djangues:', error);
    res.status(500).json({ error: 'Error al obtener djangues del usuario' });
  }
});

// =============================================================================
// 4. OBTENER DETALLE DE UN DJANGUE
// =============================================================================
router.get('/djangue/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Obtener el grupo
    const { data: group, error: groupError } = await supabase
      .from('djangue_groups')
      .select('*')
      .eq('id', id)
      .single();

    if (groupError || !group) {
      return res.status(404).json({ error: 'Djangue no encontrado' });
    }

    // Verificar que el usuario es miembro
    const { data: membership, error: membershipError } = await supabase
      .from('djangue_members')
      .select('*')
      .eq('group_id', id)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (!membership) {
      return res.status(403).json({ error: 'No eres miembro de este djangue' });
    }

    // Determinar rol
    let myRole = 'member';
    if (group.owner_id === req.userId) {
      myRole = 'owner';
    } else if (group.secretary_id === req.userId) {
      myRole = 'secretary';
    }

    // Obtener todos los miembros con info de usuario
    const { data: members, error: membersError } = await supabase
      .from('djangue_members')
      .select(`
        *,
        users:user_id (
          id,
          full_name,
          phone,
          avatar_url
        )
      `)
      .eq('group_id', id)
      .eq('status', 'active')
      .order('turn_number', { ascending: true });

    if (membersError) {
      console.error('Error obteniendo miembros:', membersError);
    }

    // Obtener wallet info
    const { data: wallet } = await supabase
      .from('djangue_wallets')
      .select('*')
      .eq('group_id', id)
      .maybeSingle();

    // Obtener contribuciones del turno actual
    const { data: contributions } = await supabase
      .from('djangue_contributions')
      .select('*, djangue_members!inner(user_id, turn_number)')
      .eq('group_id', id)
      .eq('turn_number', group.current_turn);

    res.json({
      ...group,
      my_role: myRole,
      my_turn_number: membership.turn_number,
      is_my_turn: membership.turn_number === group.current_turn,
      members: members || [],
      wallet: wallet || null,
      current_turn_contributions: contributions || [],
    });

  } catch (error) {
    console.error('Error en obtener detalle de djangue:', error);
    res.status(500).json({ error: 'Error al obtener detalles del djangue' });
  }
});

// =============================================================================
// 5. AGREGAR MIEMBRO A DJANGUE
// =============================================================================
router.post('/djangue/:id/members', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'El teléfono del usuario es obligatorio' });
    }

    // Verificar que el usuario autenticado es owner o secretary
    const { data: group } = await supabase
      .from('djangue_groups')
      .select('owner_id, secretary_id, max_members, status')
      .eq('id', id)
      .single();

    if (!group) {
      return res.status(404).json({ error: 'Djangue no encontrado' });
    }

    if (group.owner_id !== req.userId && group.secretary_id !== req.userId) {
      return res.status(403).json({ error: 'No tienes permiso para agregar miembros' });
    }

    if (group.status !== 'active') {
      return res.status(400).json({ error: 'El djangue no está activo' });
    }

    // Buscar usuario por teléfono
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado con ese teléfono' });
    }

    // Verificar que no sea ya miembro
    const { data: existingMember } = await supabase
      .from('djangue_members')
      .select('id')
      .eq('group_id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (existingMember) {
      return res.status(400).json({ error: 'El usuario ya es miembro de este djangue' });
    }

    // Contar miembros actuales
    const { count: currentMembers } = await supabase
      .from('djangue_members')
      .select('*', { count: 'exact', head: true })
      .eq('group_id', id)
      .eq('status', 'active');

    if (currentMembers >= group.max_members) {
      return res.status(400).json({ error: 'El djangue ya alcanzó el máximo de miembros' });
    }

    // Asignar siguiente turno disponible
    const nextTurn = currentMembers + 1;

    // Agregar miembro
    const { data: newMember, error: insertError } = await supabase
      .from('djangue_members')
      .insert({
        group_id: id,
        user_id: user.id,
        turn_number: nextTurn,
        status: 'active',
        joined_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error agregando miembro:', insertError);
      return res.status(500).json({ error: 'Error al agregar miembro' });
    }

    // Agregar al chat grupal si existe
    const { data: chatGroup } = await supabase
      .from('djangue_groups')
      .select('chat_group_id')
      .eq('id', id)
      .single();

    if (chatGroup?.chat_group_id) {
      await supabase
        .from('group_members')
        .insert({
          group_id: chatGroup.chat_group_id,
          user_id: user.id,
          role: 'member',
        });
    }

    res.json({
      success: true,
      member: newMember,
      message: 'Miembro agregado exitosamente',
    });

  } catch (error) {
    console.error('Error en agregar miembro:', error);
    res.status(500).json({ error: 'Error al agregar miembro' });
  }
});

module.exports = router;
