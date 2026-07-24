import SwiftUI

enum DiscoveryDatePreset: String, CaseIterable, Identifiable {
    case none
    case today
    case tomorrow
    case weekend
    case custom

    var id: String { rawValue }

    var titleKey: String.LocalizationValue {
        switch self {
        case .none: "discovery.filter.date.any"
        case .today: "discovery.filter.date.today"
        case .tomorrow: "discovery.filter.date.tomorrow"
        case .weekend: "discovery.filter.date.weekend"
        case .custom: "discovery.filter.date.custom"
        }
    }
}

struct DiscoveryDateFilterEngine {
    let now: Date

    init(now: Date = Date()) {
        self.now = now
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo") ?? .current
        return calendar
    }

    func todayRange() -> (after: Date, before: Date) {
        let startOfTomorrow = calendar.startOfDay(
            for: calendar.date(byAdding: .day, value: 1, to: now) ?? now
        )
        return (now, startOfTomorrow)
    }

    func tomorrowRange() -> (after: Date, before: Date) {
        let startOfTomorrow = calendar.startOfDay(
            for: calendar.date(byAdding: .day, value: 1, to: now) ?? now
        )
        let startOfDayAfter = calendar.date(byAdding: .day, value: 1, to: startOfTomorrow)
            ?? startOfTomorrow
        return (startOfTomorrow, startOfDayAfter)
    }

    func weekendRange() -> (after: Date, before: Date) {
        let startOfToday = calendar.startOfDay(for: now)
        let weekday = calendar.component(.weekday, from: startOfToday)
        // weekday: 1 = Sunday ... 7 = Saturday
        let daysUntilSaturday = weekday == 1 ? 0 : (7 - weekday)
        let saturday = calendar.date(byAdding: .day, value: daysUntilSaturday, to: startOfToday)
            ?? startOfToday
        let sundayEndAnchor = weekday == 1
            ? startOfToday
            : (calendar.date(byAdding: .day, value: 1, to: saturday) ?? saturday)
        let end = calendar.date(byAdding: .day, value: 1, to: sundayEndAnchor) ?? sundayEndAnchor
        let start = max(now, weekday == 1 ? startOfToday : saturday)
        return (start, end)
    }

    func customRange(from startDay: Date, to endDay: Date) -> (after: Date, before: Date) {
        let after = calendar.startOfDay(for: startDay)
        let beforeAnchor = calendar.startOfDay(for: max(startDay, endDay))
        let before = calendar.date(byAdding: .day, value: 1, to: beforeAnchor) ?? beforeAnchor
        return (after, before)
    }

    func detectPreset(startsAfter: Date?, startsBefore: Date?) -> DiscoveryDatePreset {
        guard startsAfter != nil || startsBefore != nil else { return .none }
        let today = todayRange()
        if let startsAfter, let startsBefore,
           startsBefore == today.before,
           calendar.isDate(startsAfter, inSameDayAs: now) {
            return .today
        }
        let tomorrow = tomorrowRange()
        if startsAfter == tomorrow.after, startsBefore == tomorrow.before {
            return .tomorrow
        }
        let weekend = weekendRange()
        if let startsAfter, let startsBefore,
           startsBefore == weekend.before,
           startsAfter >= calendar.startOfDay(for: weekend.after),
           startsAfter < weekend.before {
            return .weekend
        }
        return .custom
    }

    func chipLabel(startsAfter: Date?, startsBefore: Date?, locale: Locale) -> String? {
        switch detectPreset(startsAfter: startsAfter, startsBefore: startsBefore) {
        case .none:
            return nil
        case .today:
            return DiscoveryHomeLocalization.text("discovery.filter.date.today", locale: locale)
        case .tomorrow:
            return DiscoveryHomeLocalization.text("discovery.filter.date.tomorrow", locale: locale)
        case .weekend:
            return DiscoveryHomeLocalization.text("discovery.filter.date.weekend", locale: locale)
        case .custom:
            let style = Date.FormatStyle(locale: locale, timeZone: calendar.timeZone)
                .month(.defaultDigits)
                .day()
            let startText = startsAfter.map { $0.formatted(style) }
            let endText = startsBefore
                .flatMap { calendar.date(byAdding: .day, value: -1, to: $0) }
                .map { $0.formatted(style) }
            switch (startText, endText) {
            case (let start?, let end?):
                return start == end ? start : "\(start) – \(end)"
            case (let start?, nil):
                return start
            case (nil, let end?):
                return end
            case (nil, nil):
                return nil
            }
        }
    }
}

struct DiscoveryFilterSheet: View {
    @Environment(\.locale) private var locale
    @Environment(\.dismiss) private var dismiss
    let store: DiscoveryStore
    let selectSort: (EventDiscoverySort?) -> Void

    @State private var customStartDay = Date()
    @State private var customEndDay = Date()
    @State private var selectedPreset: DiscoveryDatePreset = .none

    private var engine: DiscoveryDateFilterEngine { DiscoveryDateFilterEngine() }

    var body: some View {
        NavigationStack {
            Form {
                dateSection
                formatSection
                languageSection
                priceSection
                availabilitySection
                sortSection
                clearSection
            }
            .navigationTitle(text("discovery.filter.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(text("discovery.filter.done"), action: dismiss.callAsFunction)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear(perform: synchronizeFromStore)
        .accessibilityIdentifier("discovery.filter-sheet")
    }

    private var dateSection: some View {
        Section(text("discovery.filter.date")) {
            Picker(text("discovery.filter.date"), selection: presetBinding) {
                ForEach(DiscoveryDatePreset.allCases) { preset in
                    Text(verbatim: text(preset.titleKey)).tag(preset)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if selectedPreset == .custom {
                DatePicker(
                    text("discovery.filter.date.starts"),
                    selection: customStartBinding,
                    displayedComponents: .date
                )
                DatePicker(
                    text("discovery.filter.date.ends"),
                    selection: customEndBinding,
                    in: customStartDay...,
                    displayedComponents: .date
                )
            }
        }
    }

    private var formatSection: some View {
        Section(text("discovery.filter.format")) {
            Picker(text("discovery.filter.format"), selection: formatBinding) {
                Text(verbatim: text("discovery.filter.any")).tag(EventFormat?.none)
                Text(verbatim: text("discovery.filter.format.in_person"))
                    .tag(EventFormat?.some(.inPerson))
                Text(verbatim: text("discovery.filter.format.online"))
                    .tag(EventFormat?.some(.online))
                Text(verbatim: text("discovery.filter.format.hybrid"))
                    .tag(EventFormat?.some(.hybrid))
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    private var languageSection: some View {
        Section(text("discovery.filter.language")) {
            Picker(text("discovery.filter.language"), selection: languageBinding) {
                Text(verbatim: text("discovery.filter.any")).tag(EventLocale?.none)
                Text(verbatim: text("discovery.filter.language.zh"))
                    .tag(EventLocale?.some(.zhHans))
                Text(verbatim: text("discovery.filter.language.ja")).tag(EventLocale?.some(.ja))
                Text(verbatim: text("discovery.filter.language.en")).tag(EventLocale?.some(.en))
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    private var priceSection: some View {
        Section(text("discovery.filter.price")) {
            Picker(text("discovery.filter.price"), selection: priceBinding) {
                Text(verbatim: text("discovery.filter.any")).tag(EventPriceFilter?.none)
                Text(verbatim: text("discovery.filter.price.free"))
                    .tag(EventPriceFilter?.some(.free))
                Text(verbatim: text("discovery.filter.price.paid"))
                    .tag(EventPriceFilter?.some(.paid))
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    private var availabilitySection: some View {
        Section {
            Toggle(text("discovery.filter.available"), isOn: availableBinding)
                .tint(SpottColor.twilight)
        }
    }

    private var sortSection: some View {
        Section(text("discovery.sort.title")) {
            Picker(text("discovery.sort.title"), selection: sortBinding) {
                ForEach(EventDiscoverySort.allCases, id: \.self) { option in
                    Text(verbatim: text(option.titleKey)).tag(option)
                }
            }
            .pickerStyle(.menu)
            .tint(SpottColor.twilight)
            .labelsHidden()
            .accessibilityIdentifier("discovery.filter.sort")
        }
    }

    private var sortBinding: Binding<EventDiscoverySort> {
        Binding(
            get: { store.sort ?? .recommended },
            set: { value in
                selectSort(value == .recommended ? nil : value)
            }
        )
    }

    private var clearSection: some View {
        Section {
            Button(role: .destructive) {
                selectedPreset = .none
                store.clearFilters()
            } label: {
                Text(verbatim: text("discovery.filter.clear_all"))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
        }
    }

    private var presetBinding: Binding<DiscoveryDatePreset> {
        Binding(
            get: { selectedPreset },
            set: { preset in
                selectedPreset = preset
                applyDatePreset(preset)
            }
        )
    }

    private var customStartBinding: Binding<Date> {
        Binding(
            get: { customStartDay },
            set: { value in
                customStartDay = value
                if customEndDay < value { customEndDay = value }
                applyCustomRange()
            }
        )
    }

    private var customEndBinding: Binding<Date> {
        Binding(
            get: { customEndDay },
            set: { value in
                customEndDay = value
                applyCustomRange()
            }
        )
    }

    private var formatBinding: Binding<EventFormat?> {
        Binding(
            get: { store.format },
            set: { value in
                store.format = value
                store.filtersDidChange()
            }
        )
    }

    private var languageBinding: Binding<EventLocale?> {
        Binding(
            get: { store.language },
            set: { value in
                store.language = value
                store.filtersDidChange()
            }
        )
    }

    private var priceBinding: Binding<EventPriceFilter?> {
        Binding(
            get: { store.price },
            set: { value in
                store.price = value
                store.filtersDidChange()
            }
        )
    }

    private var availableBinding: Binding<Bool> {
        Binding(
            get: { store.availableOnly == true },
            set: { value in
                store.availableOnly = value ? true : nil
                store.filtersDidChange()
            }
        )
    }

    private func synchronizeFromStore() {
        selectedPreset = engine.detectPreset(
            startsAfter: store.startsAfter,
            startsBefore: store.startsBefore
        )
        if selectedPreset == .custom {
            if let startsAfter = store.startsAfter { customStartDay = startsAfter }
            if let startsBefore = store.startsBefore { customEndDay = startsBefore }
        }
    }

    private func applyDatePreset(_ preset: DiscoveryDatePreset) {
        switch preset {
        case .none:
            store.startsAfter = nil
            store.startsBefore = nil
        case .today:
            let range = engine.todayRange()
            store.startsAfter = range.after
            store.startsBefore = range.before
        case .tomorrow:
            let range = engine.tomorrowRange()
            store.startsAfter = range.after
            store.startsBefore = range.before
        case .weekend:
            let range = engine.weekendRange()
            store.startsAfter = range.after
            store.startsBefore = range.before
        case .custom:
            applyCustomRange()
            return
        }
        store.filtersDidChange()
    }

    private func applyCustomRange() {
        let range = engine.customRange(from: customStartDay, to: customEndDay)
        store.startsAfter = range.after
        store.startsBefore = range.before
        store.filtersDidChange()
    }

    private func text(_ key: String.LocalizationValue) -> String {
        DiscoveryHomeLocalization.text(key, locale: locale)
    }
}
